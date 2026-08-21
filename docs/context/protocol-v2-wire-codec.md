# Protocol V2 wire codec bounds

V2 incremental decoders apply `MAX_V2_ARRAY_ITEMS` to CBOR arrays/maps and `MAX_V2_JSON_DEPTH + 3` to CBOR nesting before TypeBox schema validation. The three additional levels account for the message envelope and payload property around bounded JSON values. V2 public `is*` and `parse*` paths reject non-finite JavaScript numbers; V1 codec validation remains on its existing behavior.
