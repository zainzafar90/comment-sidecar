'use strict';

const properties = require('../../package.json').contributes.configuration.properties;

const definitions = Object.entries(properties).map(([name, schema]) => [
  name.slice('commentSidecar.'.length), schema,
]);

function readSettings(configuration) {
  const settings = {};
  for (const [key, schema] of definitions) {
    const value = configuration.get(key, schema.default);
    const validType = typeof value === schema.type;
    const validChoice = !schema.enum || schema.enum.includes(value);
    settings[key] = validType && validChoice ? value : schema.default;
  }

  return settings;
}

module.exports = { readSettings };
