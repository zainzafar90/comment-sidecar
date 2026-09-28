'use strict';
const SUFFIX = '.comment';

function sidecarOf(sourcePath) {
  return `${sourcePath}${SUFFIX}`;
}

function sourceOf(sidecarPath) {
  return sidecarPath.slice(0, -SUFFIX.length);
}

function isSidecar(file) {
  return file.endsWith(SUFFIX);
}

module.exports = { SUFFIX, sidecarOf, sourceOf, isSidecar };
