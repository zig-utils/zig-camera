//! Per-sink workers. Only copied sink operations cross the thread boundary;
//! container/encoder state and attachment ownership stay on the recorder caller.
const std = @import("std");
const c = @import("abi.zig").c;
const A = std.heap.c_allocator;
pub const Event = struct { kind: enum { write, patch, packet }, offset: u64 = 0, timestamp: u64 = 0, codec: u32 = 0, flags: u32 = 0 };
pub const Config = struct { bytes: usize, items: u32, wait_ns: u64 };
const Fence = struct {
    refs: std.atomic.Value(usize) = .init(1),
    jobs: std.atomic.Value(usize) = .init(0),
    event: std.Thread.ResetEvent = .{},
    mutex: std.Thread.Mutex = .{},
    changed: std.Thread.Condition = .{},
    progress: @import("home/completion_watermark.zig").Watermark = .{},
    fn reserve(s: *Fence) !void {
        s.mutex.lock();
        defer s.mutex.unlock();
        _ = try s.progress.reserve();
    }
    fn complete(s: *Fence) void {
        s.mutex.lock();
        defer s.mutex.unlock();
        s.progress.complete() catch unreachable;
        s.changed.broadcast();
    }
    fn finish(s: *Fence, code: c_int) void {
        s.mutex.lock();
        defer s.mutex.unlock();
        if (code != c.ZC_OK) s.progress.fail(code);
        s.changed.broadcast();
    }
    fn retain(s: *Fence) void {
        _ = s.refs.fetchAdd(1, .monotonic);
    }
    fn release(s: *Fence) void {
        if (s.refs.fetchSub(1, .acq_rel) == 1) A.destroy(s);
    }
};
/// A retained prefix, never a borrowed Worker/Output/Recorder pointer.
pub const Drain = struct {
    const Prefix = struct { fence: *Fence, target: u64 };
    current: ?Prefix,
    previous: ?Prefix,
    initial_failure: c_int = c.ZC_OK,
    fn pin(worker: ?*Worker) ?Prefix {
        const w = worker orelse return null;
        w.done.retain();
        w.done.mutex.lock();
        defer w.done.mutex.unlock();
        return .{ .fence = w.done, .target = w.done.progress.issued };
    }
    pub fn create(current: ?*Worker, previous: ?*Worker) !*Drain {
        if (current) |w| {
            if (w.done.jobs.fetchAdd(1, .acq_rel) >= 32) {
                _ = w.done.jobs.fetchSub(1, .acq_rel);
                return error.BufferFull;
            }
        }
        errdefer if (current) |w| {
            _ = w.done.jobs.fetchSub(1, .acq_rel);
        };
        const s = try A.create(Drain);
        s.* = .{ .current = pin(current), .previous = pin(previous) };
        return s;
    }
    pub fn destroy(s: *Drain) void {
        if (s.current) |p| {
            _ = p.fence.jobs.fetchSub(1, .acq_rel);
            p.fence.release();
        }
        if (s.previous) |p| p.fence.release();
        A.destroy(s);
    }
    pub fn wait(s: *Drain, timeout_ms: u32) c_int {
        var timer = std.time.Timer.start() catch return c.ZC_IO;
        const limit = @as(u64, timeout_ms) * std.time.ns_per_ms;
        var failure: c_int = s.initial_failure;
        for ([_]?Prefix{ s.previous, s.current }) |maybe| {
            const p = maybe orelse continue;
            p.fence.mutex.lock();
            defer p.fence.mutex.unlock();
            while (true) {
                switch (p.fence.progress.poll(p.target) catch unreachable) {
                    .success => break,
                    .failure => |code| {
                        if (failure == c.ZC_OK) failure = code;
                        break;
                    },
                    .pending => {},
                }
                if (timer.read() >= limit) return c.ZC_TIMEOUT;
                p.fence.changed.timedWait(&p.fence.mutex, limit -| timer.read()) catch {};
            }
        }
        return failure;
    }
};
pub const Worker = struct {
    queue: @import("home/owned_fifo.zig").Queue(Event),
    scratch: []u8,
    mutex: std.Thread.Mutex = .{},
    changed: std.Thread.Condition = .{},
    thread: ?std.Thread = null,
    done: *Fence,
    predecessor: ?*Fence,
    context: *anyopaque,
    apply: *const fn (*anyopaque, Event, []const u8) c_int,
    config: Config,
    closing: bool = false,
    finalizing: bool = false,
    failure: c_int = c.ZC_OK,
    accepted: u64 = 0,
    completed: u64 = 0,
    rejected: u64 = 0,
    high_bytes: u64 = 0,
    high_items: u64 = 0,
    pub fn create(config: Config, context: *anyopaque, apply: *const fn (*anyopaque, Event, []const u8) c_int, previous: ?*Worker) !*Worker {
        const s = try A.create(Worker);
        errdefer A.destroy(s);
        var queue = try @import("home/owned_fifo.zig").Queue(Event).init(A, config.bytes, config.items);
        errdefer queue.deinit();
        const scratch = try A.alloc(u8, config.bytes);
        errdefer A.free(scratch);
        const done = try A.create(Fence);
        done.* = .{};
        errdefer done.release();
        s.* = .{ .queue = queue, .scratch = scratch, .done = done, .predecessor = if (previous) |p| p.done else null, .config = config, .context = context, .apply = apply };
        if (s.predecessor) |p| p.retain();
        errdefer if (s.predecessor) |p| p.release();
        s.thread = try std.Thread.spawn(.{}, run, .{s});
        return s;
    }
    pub fn destroy(s: *Worker) void {
        s.close(false);
        s.thread.?.join();
        if (s.predecessor) |p| p.release();
        s.done.release();
        s.queue.deinit();
        A.free(s.scratch);
        A.destroy(s);
    }
    pub fn errorCode(s: *Worker) c_int {
        s.mutex.lock();
        defer s.mutex.unlock();
        return s.failure;
    }
    pub fn ready(s: *Worker) bool {
        return s.done.event.isSet();
    }
    pub fn abort(s: *Worker, code: c_int) void {
        s.mutex.lock();
        defer s.mutex.unlock();
        if (s.failure == c.ZC_OK) s.failure = code;
        s.closing = true;
        s.changed.broadcast();
    }
    pub fn close(s: *Worker, drain_pending: bool) void {
        s.mutex.lock();
        defer s.mutex.unlock();
        s.closing = true;
        if (!drain_pending and s.queue.count != 0 and s.failure == c.ZC_OK) s.failure = c.ZC_STATE;
        s.changed.broadcast();
    }
    pub fn finalize(s: *Worker) void {
        s.mutex.lock();
        defer s.mutex.unlock();
        s.finalizing = true;
    }
    pub fn drain(s: *Worker) c_int {
        s.mutex.lock();
        defer s.mutex.unlock();
        while (s.queue.count != 0) s.changed.wait(&s.mutex);
        return s.failure;
    }
    pub fn send(s: *Worker, event: Event, data: []const u8) !void {
        var timer = try std.time.Timer.start();
        s.mutex.lock();
        defer s.mutex.unlock();
        if (s.failure != c.ZC_OK or s.closing) return error.AsyncOutputFailed;
        if (data.len > s.queue.bytes.len) {
            s.rejected += 1;
            s.failure = c.ZC_INVALID;
            s.closing = true;
            s.changed.broadcast();
            return error.PacketTooLarge;
        }
        while (!s.queue.fits(data.len)) {
            if (!s.finalizing and (s.config.wait_ns == 0 or timer.read() >= s.config.wait_ns)) {
                s.rejected += 1;
                s.failure = c.ZC_BUSY;
                s.closing = true;
                s.changed.broadcast();
                return error.BufferFull;
            }
            if (s.finalizing) s.changed.wait(&s.mutex) else s.changed.timedWait(&s.mutex, s.config.wait_ns -| timer.read()) catch {};
            if (s.failure != c.ZC_OK or s.closing) return error.AsyncOutputFailed;
        }
        try s.done.reserve();
        s.queue.push(event, data) catch unreachable;
        s.accepted += 1;
        s.high_bytes = @max(s.high_bytes, s.queue.used);
        s.high_items = @max(s.high_items, s.queue.count);
        s.changed.broadcast();
    }
    pub fn stats(s: *Worker, out: *c.zc_output_io_stats) void {
        s.mutex.lock();
        defer s.mutex.unlock();
        out.queued_bytes = s.queue.used;
        out.queued_ops = s.queue.count;
        out.accepted_ops = s.accepted;
        out.completed_ops = s.completed;
        out.rejected_ops = s.rejected;
        out.high_bytes = s.high_bytes;
        out.high_ops = s.high_items;
        out.error_code = s.failure;
        out.max_bytes = s.config.bytes;
        out.max_ops = s.config.items;
        out.wait_ns = s.config.wait_ns;
        out.running = @intFromBool(!s.ready());
    }
    fn run(s: *Worker) void {
        defer s.done.event.set();
        var first = true;
        s.mutex.lock();
        defer {
            s.done.finish(s.failure);
            s.mutex.unlock();
        }
        while (true) {
            while (s.queue.count == 0 and !s.closing) s.changed.wait(&s.mutex);
            if (s.failure != c.ZC_OK or s.queue.count == 0) {
                s.queue.reset();
                s.changed.broadcast();
                return;
            }
            const event = s.queue.front().?.value;
            const data = s.queue.copyFront(s.scratch) catch unreachable;
            s.mutex.unlock();
            // A new segment may queue immediately, but its callbacks (including
            // a shared observer PTS stream) start only after the old epoch ends.
            if (first) {
                if (s.predecessor) |p| p.event.wait();
                first = false;
            }
            s.mutex.lock();
            if (s.failure != c.ZC_OK) {
                s.queue.reset();
                s.changed.broadcast();
                return;
            }
            s.mutex.unlock();
            const code = s.apply(s.context, event, data);
            s.mutex.lock();
            s.queue.pop();
            if (code == c.ZC_OK) {
                s.completed += 1;
                s.done.complete();
            } else if (s.failure == c.ZC_OK) {
                s.failure = code;
                s.closing = true;
            }
            s.changed.broadcast();
        }
    }
};
