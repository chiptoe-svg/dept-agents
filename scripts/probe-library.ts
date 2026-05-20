import { listLibrary } from '../src/channels/playground/library.js';

const entries = listLibrary();
console.log('count:', entries.length);
console.log(JSON.stringify(entries.slice(0, 5), null, 2));
