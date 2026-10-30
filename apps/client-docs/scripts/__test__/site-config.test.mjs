import {test} from 'node:test';
import assert from 'node:assert/strict';
import {documentationBase,documentationSite} from '../../config/site.mjs';

test('normalizes local and GitHub Pages deployment prefixes',()=>{
  assert.equal(documentationBase(),'/');
  assert.equal(documentationBase('Vykor/client-sdk'),'/Vykor/client-sdk/');
  assert.equal(documentationBase('/client-sdk/'),'/client-sdk/');
});

test('rejects traversal and full URLs where a deployment prefix is required',()=>{
  for(const base of ['../docs','/a/../docs','https://example.com/docs','//example.com/docs','/a\\docs','/docs?query=x','/%2e%2e/']) {
    assert.throws(()=>documentationBase(base),Error);
  }
});

test('extracts only the public origin from a Pages URL',()=>{
  assert.equal(documentationSite('https://example.com/Vykor'),'https://example.com');
  assert.equal(documentationSite(),undefined);
  assert.throws(()=>documentationSite('https://user:password@example.com'),Error);
  assert.throws(()=>documentationSite('file:///tmp/docs'),Error);
});
