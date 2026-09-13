# Use Git staging for ordinary commits

Ordinary commits use the real Git index when it contains changes; otherwise they include all non-ignored Working Changes. Opening the commit form does not stage files. Edits made after staging remain outside a commit of the staged snapshot.

This revises ADR 0008 following the SOX-135 prototype. Direct file selection offered less UI, but a real staged snapshot makes existing staging authoritative and lets users distinguish included content from later edits. Staging controls appear only with the inline commit form, preserving compact file inspection outside that flow. The commit action identifies whether it includes staged content or all changes.

Git's index still cannot express arbitrary destinations. SOX-140's transfers among Working Changes, commits, branches, and new-commit seams continue to use exact Change Selection independently of ordinary commit staging.
