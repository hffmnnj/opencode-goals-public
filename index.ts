// Compatibility shim for the pinned OpenCode 2.0.25 directory plugin loader.
//
// Observed behavior on pinned 2.0.25 (isolated probe): configuring this package
// by directory loads the package root, not package.json exports["."]. A package
// with only exports["."] -> ./dist/index.js was absent from the loaded plugin
// list, and a direct file path was rejected ("configured plugin path must be a
// directory"). Adding this root re-export fixed loading; an exports["./server"]
// alias alone did not. Keep package.json exports primary on dist; this file only
// forwards the default plugin export. Direct file paths are not supported by the
// pinned host and must not be documented as working.
export { default } from './dist/index.js?revision=2443cd8df23eb5c294613f6c41f41bf57ae1715320b514ff6fda4486d88e3a11';
