# Historical DB2 corpus scope — #4490

The 100-entry file `src-tauri/src/db2_missing_index_examples.json` remains in its original path and is preserved byte-for-byte from rescue commit `0e9338e`. Its SHA256 is `0ee5e3272dc0c8670e3beb7b3a51310bf857dc4dad18446b4150e113819024c6` (76,735 bytes).

Disposition: retained historical user material, outside Daemonic's shipping feature scope. No app source imports or embeds it, and Tauri's bundle configuration has no resource declaration for it. The production bundle is inspected separately to confirm absence. No file is moved or deleted and no training, DB2 access or SQL execution is authorized by this disposition.

Static metadata checks find six queries containing `undefined` and nine reused index names with differing definitions. The corpus's speedup numbers and ordinary-index recommendations are not benchmark results or a validated DB2 design. They must not support product, training-quality or performance claims. Further ownership or relocation requires the orchestrator's scope decision.
