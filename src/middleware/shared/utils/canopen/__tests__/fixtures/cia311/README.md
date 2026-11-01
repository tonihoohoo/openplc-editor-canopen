# CiA 311 check fixtures

Generic test files, not of any real device. `expected.json` holds each file's verdict of the
editor's CiA 311 check (`checkXdd`) and whether it passes the CiA 311 v1.1 schema; the cross-check
workflow validates them against the schema at run time.

- `generic-io-module.xdd`: the XDD the editor writes from `../generic-io-module.eds`.
- `generic-io-module-full.xdd` and `.xdc`: a generic I/O module with every CiA 301 communication
  object, the CiA 401 objects of 8 digital inputs, 8 digital outputs, 2 analogue inputs and 1
  analogue output, a manufacturer area with every basic data type, two languages, units, ranges,
  value meanings, bit fields, groups and characteristics; the XDC adds commissioning, actual values
  and denotations.
- `missing-ref.xdd`, `type-mismatch.xdd`, `version-1-0.xdd`, `no-namespace.xdd`, `settings.xdc`,
  `no-node-id.xdc`, `other-fieldbus.xdd`: `generic-io-module.xdd` with one problem or setting each.
