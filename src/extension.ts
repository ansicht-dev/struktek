/**
 * The extension-host entry point.
 *
 * A shim, so `main` in the manifest never has to track where activation
 * actually lives.
 */

export { activate, deactivate } from './host/extension';
