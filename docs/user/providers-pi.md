# Pi

Rove Code embeds Pi through its SDK on the machine running the server. A remote client uses that server's Pi credentials and configuration, not a Pi installation on the client device.

Authenticate your model provider with Pi on the server, then enable **Pi** in Rove Code's provider settings. **Pi agent directory** selects a separate configuration directory for an instance; leave it blank for the server's default. Instances using the same directory can resume each other's sessions.

## Configuration and extensions

Pi reads global resources from `~/.pi/agent`, or `PI_CODING_AGENT_DIR`, and project resources from the thread's working directory. Global extensions, `.pi/extensions/`, and packages configured in Pi's settings run on the server with its permissions. Only start Pi threads in repositories you trust. Configuration changes take effect when the next Pi session starts.

Rove Code uses Pi's model catalog and supported reasoning levels. It does not run paid inference requests to probe model capabilities. Background text generation, such as thread titles, does not load extensions or keep session history.

## Models and extension catalog

The Extensions control beside a Pi provider selector opens that instance's global catalog on web and mobile. Refresh re-reads its global extensions and model catalog from the server; project-local extensions load only in their project's threads. Disabling an extension excludes its tools and models from new sessions, is saved per instance, and takes effect after running turns finish.

Use the model and reasoning pickers to choose capabilities reported by Pi. If an extension model is removed or its reasoning level is unsupported, Rove Code shows the effective selection or a startup error rather than silently keeping an unavailable choice. In provider settings, **Use Pi default** clears the thinking override.

## Session recovery

Rove saves each Pi session's identity and absolute file location on the server. Sessions remain recoverable when a thread's working directory changes, provided the saved file remains accessible. Older sessions without a saved file location use Pi's working-directory lookup.

Rollback positions are saved as exact session-tree boundaries, so steering messages sent while a turn runs never count as extra turns. Threads whose history predates exact boundaries cannot roll back; start a new thread instead.

If history is missing, unreadable, empty, or belongs to another session, startup fails instead of silently starting an empty conversation. Restore the session file or storage access on the server, then retry the turn. To continue without that history, create a new thread. The original thread keeps its saved session reference for recovery.

New sessions are saved before the first prompt, so restarting before the first assistant response does not invalidate their session reference.

## Resource limits on Linux and WSL

Heavy tools such as concurrent builds and typechecks can exhaust RAM and cause disk saturation from swapping, making a remote server unreachable. In web or desktop **Settings → Providers → Pi**, choose **Workload protection** and a shared **Workload memory (MiB)** limit. Auto enables protection on Linux or WSL hosts with 768 MiB–8 GiB RAM, a systemd user manager, and `flock`. On requires that support; Off opts out. Settings survive server restarts. If an existing instance has not picked up a change, disable and re-enable it when no threads are running.

Protected Pi shell calls queue across threads, instances, and Rove environments running as the same OS user: only one foreground shell runs at a time. Reads, edits, and model responses do not wait for that slot. Shell calls have a default 600-second deadline, including queue time; the tool's timeout can override it. Parallel commands inside one shell still share its budget.

Auto caps the configured budget at half the host's RAM to leave room for the OS and Pi. On and the environment override use the requested limit unchanged. The default 2048 MiB budget reserves two thirds for the foreground command and one third for a managed background service, with no workload swap and a shared two-core CPU ceiling. Pi and Rove stay outside the command pool. Exceeding a command's share stops that command and its descendants, reports a memory-budget error, and leaves Pi connected. A job that needs more memory must be reduced, moved to a larger host, or given a larger budget; running slower cannot make it fit.

For a dev server, ask the agent to use `workload_start`, not shell `&` or `nohup`. One managed background service can run per OS user while foreground commands continue. `workload_list` shows this thread's service and its recent output; `workload_stop` stops it. A service stops when its owning session or Pi runtime closes, including after a runtime crash. Foreground calls stop hidden background descendants before releasing the slot.

`ROVE_PI_MEMORY_BUDGET_MIB` remains an advanced override: it enables protection and overrides both settings, even Off. Remove it to let Settings control the policy. All protected instances must resolve to the same budget; avoid mixing Auto and On where Auto reduces the limit. To resize an already configured pool, first stop protected work and disable the affected instances, then run `systemctl --user stop rove-command-workloads.slice` on the host and re-enable them with the new value. Never stop the pool while work is active.

This is workload management, not a security sandbox. Other providers, extension code running inside Pi, extension tools that start processes directly, and commands deliberately moved into another systemd scope are not automatically protected. Such extensions can still interrupt their Pi instance. Prefer the protected shell tools for expensive work.
