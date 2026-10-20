//! One persistent worker and bounded copied producer inputs per recorder.
const std = @import("std");
const c = @import("abi.zig").c;
const A = std.heap.c_allocator;
const Admission = @import("home/owned_admission.zig").Registry(8);
threadlocal var current_job: ?*Job = null;
pub fn handoff(id: u64, generation: u64) void {
    const job = current_job orelse return;
    const count = job.handoff_count.load(.monotonic);
    std.debug.assert(count < job.handoffs.len);
    job.handoffs[count] = .{ .id = id, .generation = generation };
    job.handoff_count.store(count + 1, .release);
}
pub const Job = struct {
    pub const AudioPart = struct { offset: usize, length: usize, timestamp: u64 };
    owner: *Pool,
    ticket: Admission.Ticket,
    data: []u8,
    parts: []AudioPart = &.{},
    frame: c.zc_frame = std.mem.zeroes(c.zc_frame),
    timestamp: u64,
    audio: bool,
    started: bool = false,
    released: bool = false,
    done: std.atomic.Value(bool) = .init(false),
    code: c_int = c.ZC_TIMEOUT,
    handoffs: [8]c.zc_producer_handoff = undefined,
    handoff_count: std.atomic.Value(u32) = .init(0),
};
pub const Pool = struct {
    context: *anyopaque,
    apply: *const fn (*anyopaque, *Job) c_int,
    admission: Admission,
    mutex: std.Thread.Mutex = .{},
    changed: std.Thread.Condition = .{},
    thread: ?std.Thread = null,
    request: ?*Job = null,
    active: std.atomic.Value(bool) = .init(false),
    closing: bool = false,
    completed: u64 = 0,
    failed: u64 = 0,
    cancelled: u64 = 0,
    pub fn create(context: *anyopaque, apply: *const fn (*anyopaque, *Job) c_int, bytes: usize, jobs: u32) !*Pool {
        const admission = try Admission.init(bytes, jobs);
        const self = try A.create(Pool);
        self.* = .{ .context = context, .apply = apply, .admission = admission };
        return self;
    }
    pub fn allocate(self: *Pool, bytes: usize, audio: bool, timestamp: u64, parts: usize) !*Job {
        self.mutex.lock();
        defer self.mutex.unlock();
        const charge = try std.math.add(usize, bytes, try std.math.mul(usize, parts, @sizeOf(Job.AudioPart)));
        const ticket = try self.admission.reserve(charge);
        errdefer self.admission.release(ticket) catch unreachable;
        const job = try A.create(Job);
        errdefer A.destroy(job);
        const data = try A.alloc(u8, bytes);
        errdefer A.free(data);
        job.* = .{ .owner = self, .ticket = ticket, .data = data, .parts = try A.alloc(Job.AudioPart, parts), .audio = audio, .timestamp = timestamp };
        return job;
    }
    pub fn start(self: *Pool, job: *Job) c_int {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (job.started) return c.ZC_STATE;
        if (self.active.load(.acquire)) return c.ZC_BUSY;
        if (self.thread == null) self.thread = std.Thread.spawn(.{}, run, .{self}) catch return c.ZC_NOMEM;
        job.started = true;
        self.request = job;
        self.active.store(true, .release);
        self.changed.signal();
        return c.ZC_OK;
    }
    /// Reclaim the exclusive recorder turn only after worker ownership ends.
    pub fn finish(self: *Pool, job: *Job, code: *c_int) c_int {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (!job.started) return c.ZC_STATE;
        if (!job.done.load(.acquire)) return c.ZC_TIMEOUT;
        if (!job.released) {
            self.active.store(false, .release);
            job.released = true;
        }
        code.* = job.code;
        return c.ZC_OK;
    }
    pub fn release(self: *Pool, job: *Job) c_int {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (job.started and !job.released) return c.ZC_BUSY;
        if (!job.started) self.cancelled +|= 1;
        self.admission.release(job.ticket) catch unreachable;
        A.free(job.data);
        A.free(job.parts);
        A.destroy(job);
        return c.ZC_OK;
    }
    pub fn count(self: *Pool) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.admission.count;
    }
    pub fn stats(self: *Pool, out: *c.zc_producer_stats) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const a = self.admission;
        out.* = .{ .owned_bytes = a.used, .owned_jobs = a.count, .high_bytes = a.high_bytes, .high_jobs = a.high_items, .max_bytes = a.max_bytes, .max_jobs = a.max_items, .admitted = a.issued, .released = a.released, .rejected = a.rejected, .completed = self.completed, .failed = self.failed, .cancelled = self.cancelled, .running = @intFromBool(self.active.load(.acquire)), .reserved = 0 };
    }
    pub fn destroy(self: *Pool) void {
        self.mutex.lock();
        std.debug.assert(self.admission.count == 0 and !self.active.load(.acquire));
        self.closing = true;
        self.changed.signal();
        self.mutex.unlock();
        if (self.thread) |thread| thread.join();
        A.destroy(self);
    }
    fn run(self: *Pool) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        while (true) {
            while (self.request == null and !self.closing) self.changed.wait(&self.mutex);
            if (self.closing) return;
            const job = self.request.?;
            self.mutex.unlock();
            const previous = @import("output_mailbox.zig").producerScope(true);
            current_job = job;
            const code = self.apply(self.context, job);
            current_job = null;
            _ = @import("output_mailbox.zig").producerScope(previous);
            self.mutex.lock();
            self.request = null;
            self.completed +|= 1;
            if (code != c.ZC_OK) self.failed +|= 1;
            job.code = code;
            job.done.store(true, .release);
        }
    }
};
