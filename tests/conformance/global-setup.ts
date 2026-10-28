import { buildHost } from './rust-core';

/** Build the host once and point every worker at that binary. */
export default function setup() {
  process.env.BUREAU_HOST_BIN = buildHost();
}
