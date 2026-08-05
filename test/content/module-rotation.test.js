'use strict';

const test = require('node:test');
const assert = require('node:assert');
const rotation = require('../../core/content/module-rotation');

test('primary rotation contains the six highest-impact FGA modules', () => {
  assert.deepStrictEqual(rotation.PRIMARY_MODULE_ROTATION.map((module) => module.name), [
    'AI Voice Receptionist',
    'Speed-to-Lead',
    'Follow-Up Sequences',
    'Command Center',
    'Review Requests',
    'Content Engine + Content Approval',
  ]);
  for (const module of rotation.PRIMARY_MODULE_ROTATION) {
    assert.ok(module.truth.length > 40, `${module.name} needs product truth`);
    assert.ok(module.visual.length > 30, `${module.name} needs visual direction`);
  }
});

test('rotation advances from the latest module and wraps after all six', () => {
  assert.deepStrictEqual(
    rotation.nextModules([], { count: 2 }).map((module) => module.name),
    ['AI Voice Receptionist', 'Speed-to-Lead'],
  );
  const next = rotation.nextModules(['Follow-Up Sequences', 'Speed-to-Lead'], { count: 2 });
  assert.deepStrictEqual(next.map((module) => module.name), ['Command Center', 'Review Requests']);
  const wrapped = rotation.nextModules(['Content Engine + Content Approval'], { count: 2 });
  assert.deepStrictEqual(wrapped.map((module) => module.name), ['AI Voice Receptionist', 'Speed-to-Lead']);
});

test('module matching tolerates punctuation but not a different module', () => {
  const voice = rotation.PRIMARY_MODULE_ROTATION[0];
  assert.strictEqual(rotation.matchesModule('AI voice-receptionist', voice), true);
  assert.strictEqual(rotation.matchesModule('Follow-Up Sequences', voice), false);
});
