# Keep source-linked auxiliary columns transient

Status: amended by ADR-0019, which moves Branch Comparison Columns to Workspace Columns.

Workspace Columns remain persisted roots, while File History, Commit Diff, Branch Comparison, and broken-out diff columns form a renderer-owned transient graph beneath them. One lifecycle seam owns source-relative insertion, identity-based reuse, focus, visible parentage, and transitive close; this avoids encoding live investigation trees and disposable Git evidence into Workspace State while giving these auxiliary columns consistent behavior.
