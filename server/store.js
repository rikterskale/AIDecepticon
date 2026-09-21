import fs from 'node:fs';
import path from 'node:path';
import { seedState } from './seed.js';

const dataDir = path.resolve(process.env.DATA_DIR || './runtime-data');
const statePath = path.join(dataDir, 'state.json');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return clone(seedState);
  }
}

let state = load();

function persist() {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporaryPath = `${statePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2));
  fs.renameSync(temporaryPath, statePath);
}

export const store = {
  read(key) {
    return clone(state[key] || []);
  },
  add(key, item) {
    state[key] = [item, ...(state[key] || [])];
    persist();
    return clone(item);
  },
  update(key, id, changes) {
    const collection = state[key] || [];
    const index = collection.findIndex((item) => item.id === id);
    if (index === -1) return null;
    collection[index] = { ...collection[index], ...changes };
    persist();
    return clone(collection[index]);
  },
};
