import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,relative} from 'node:path';
import {checkSite} from '../check-site.mjs';

async function fixture(t,files) {
  const root=await mkdtemp(join(tmpdir(),'vykor-docs-links-'));
  t.after(async()=>{
    if (relative(resolve(tmpdir()),root).startsWith('..')) throw new Error('Unexpected fixture directory');
    await rm(root,{recursive:true,force:true});
  });
  for(const [name,content] of Object.entries(files)) {
    const file=join(root,name);await mkdir(dirname(file),{recursive:true});await writeFile(file,content);
  }
  return root;
}

test('reports a missing documentation page and a missing section',async t=>{
  const root=await fixture(t,{'index.html':'<a href="./missing/">Missing</a><a href="./guide/#absent">Section</a>','guide/index.html':'<h1 id="present">Guide</h1>'});
  const errors=await checkSite(root,{base:'/'});
  assert.equal(errors.length,2);
  assert.ok(errors.some(error=>error.includes('./missing/')));
  assert.ok(errors.some(error=>error.includes('#absent')));
});

test('checks prefixed links, relative pages and encoded Unicode anchors',async t=>{
  const root=await fixture(t,{
    'index.html':'<a href="/Vykor/client-sdk/guide/#%E5%AE%89%E8%A3%85">Install</a><a href="https://example.com/external">External</a>',
    'guide/index.html':'<h1 id="安装">Install</h1><a href="../">Home</a><a href="../favicon.svg">Icon</a>',
    'favicon.svg':'<svg/>',
  });
  assert.deepEqual(await checkSite(root,{base:'/Vykor/client-sdk/'}),[]);
});

test('rejects a root-relative link which escaped the deployment prefix',async t=>{
  const root=await fixture(t,{'index.html':'<a href="/guide/">Wrong base</a>','guide/index.html':'<h1>Guide</h1>'});
  const errors=await checkSite(root,{base:'/Vykor/client-sdk/'});
  assert.equal(errors.length,1);
  assert.ok(errors[0].includes('/guide/'));
});

test('reports missing icons and script assets in generated HTML',async t=>{
  const root=await fixture(t,{'index.html':'<link rel="icon" href="/favicon.svg"><script src="/missing.js"></script>'});
  const errors=await checkSite(root);
  assert.equal(errors.length,2);
});

test('rejects maintenance READMEs copied into public output',async t=>{
  const root=await fixture(t,{
    'index.html':'<h1>SDK</h1>',
    'README.md':'Maintenance only',
    'assets/README.md':'Asset maintenance only',
  });
  const errors=await checkSite(root);
  assert.equal(errors.length,2);
  assert.ok(errors.some(error=>error.includes('README.md')));
  assert.ok(errors.some(error=>error.includes('assets/README.md')));
});
