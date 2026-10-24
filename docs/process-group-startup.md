# Process-output startup group verification

The standalone Home supervisor establishes the consumer's process group in
both parent and child, before exec readiness. On local macOS, stress reproduced
an intermittent child `setpgid(0, 0)` failure with `EPERM`. The group can already
have been established by the parent. The helper now saves the original errno
and checks `getpgrp() == getpid()` when that redundant call fails. Only the
required owned-group postcondition allows exec to proceed; an unowned group
still fails before exec with the original error. No wire format, public ABI,
argv/env or process-group retirement policy changes.

Shared fix: home-lang/home
[5fe691d067a7aa33d60ad6fc276e2ba2aed0c121](https://github.com/home-lang/home/commit/5fe691d067a7aa33d60ad6fc276e2ba2aed0c121).
The camera copy differs only in its flattened wire import. Home's new independent
Zig consumer checks its actual group identity after exec and echoes bounded
stdin through EOF. The pinned native CI runs it through 50 joined startups on
macOS and Linux x86_64/ARM64. Pure helper matrices remain compiler-portable.

Retained local diagnostic evidence found 3 setup failures in 500 attempts with
the old helper, then 500 successful recovery runs with the guard, including two
observed already-owned fallbacks. Another 500 native-consumer sessions verified
after-exec group ownership. A separate diagnostic build without either group
establishment path still rejected before exec with EPERM and joined exit 127.
Those diagnostic builds and logs stay outside tracked production sources.
The production helper also passes the complete camera Bun/C ABI suite.

This is hosted POSIX process ownership, separate from Home OS's kernel PCB/PGID
registry. No OS code is imported or executed. Escaped groups and a hard-killed
supervisor remain separate policy work; no hardware or performance result is
inferred from this startup correction.
