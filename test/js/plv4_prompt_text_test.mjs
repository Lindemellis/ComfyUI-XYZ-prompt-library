import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const load = code => import('data:text/javascript;base64,' + Buffer.from(code + '\n//# sourceURL=plv4-prompt-text-under-test.js').toString('base64'));
const helpers = await load(await readFile(new URL('../../js/plv4/prompt_text.js', import.meta.url), 'utf8'));
const { promptDisplay, displayRun, scheduleSource, autocompleteText } = helpers;

test('PLv3 item cleanup drops boundary commas and input conversion protects literal names and settings', () => {
  assert.equal(helpers.cleanPromptInput(' ，solo， blonde hair, '),'solo, blonde hair');
  assert.equal(helpers.cleanPromptInput(' a cat. '),'a cat.');
  const source='[Folder，name]: { solo， blonde hair， (eyes:1.2)， <lora:model，name:0.7> }.set{format: "a，$p", schedule: {0, 0.5}}';
  assert.equal(helpers.normalizePromptInput(source),'[Folder，name]: { solo, blonde hair, (eyes:1.2), <lora:model，name:0.7> }.set{format: "a，$p", schedule: {0, 0.5}}');
  assert.equal(helpers.normalizePromptInput('[solo， blonde hair:0,0.5]'),'[solo, blonde hair:0,0.5]');
  assert.equal(helpers.normalizePromptInput('"literal，text"， solo'),'"literal，text", solo');
  assert.equal(helpers.normalizePromptInput('{ solo， blonde }.set{format: "}，$p"}， outside'),'{ solo, blonde }.set{format: "}，$p"}, outside');
});

function wrapper(body = 'sunrise colors', settings = { weight: 1.1, schedule: [.2, .8] }) {
  const source = `{\n    ${body}\n}.set{weight: 1.1, schedule: {0.2, 0.8}}`;
  const start = source.indexOf(body);
  const child = { id: 'tag', kind: 'item', source: body, enabled: true, effective: true, span: [start, start + body.length], children: [] };
  const row = { id: 'wrapper', kind: 'group', form: 'brace', enabled: true, effective: true,
    span: [0, source.length], source, meta: { presentation: 'prompt' }, settings, children: [child] };
  return { row, child, source };
}

test('a prompt settings shell displays attention and Prompt Control interval syntax', () => {
  const { row, source } = wrapper();
  const display = promptDisplay(row, source);
  assert.equal(display.text, '[(sunrise colors:1.1):0.2,0.8]');
  assert.ok(!display.text.includes('.set') && !display.text.includes('{'));
});

test('unchanged display reuses the exact source shell, whitespace and child offsets', () => {
  const { row, child, source } = wrapper('😀 sunrise');
  const display = displayRun([row], source, 0, source.length);
  const decoded = scheduleSource(display.text, display.originals);
  assert.equal(decoded.source, source);
  const tagStart = display.text.indexOf('😀 sunrise');
  assert.equal(decoded.offsets[tagStart], child.span[0]);
  assert.equal(decoded.offsets[tagStart + '😀 sunrise'.length], child.span[1]);
  assert.deepEqual(decoded.promptSpans, [[0, source.length]]);
});

test('editing attention and interval converts once to a single prompt shell', () => {
  const text = '[(golden sunrise:1.25), :0.15,0.7], fine details';
  const decoded = scheduleSource(text);
  assert.equal(decoded.source, '{ golden sunrise }.set{weight: 1.25, schedule: {0.15, 0.7}}, fine details');
  const a = text.indexOf('golden sunrise'), b = a + 'golden sunrise'.length;
  assert.equal(decoded.source.slice(decoded.offsets[a], decoded.offsets[b]), 'golden sunrise');
  assert.equal(decoded.source.slice(...decoded.promptSpans[0]), '{ golden sunrise }.set{weight: 1.25, schedule: {0.15, 0.7}}');
});

test('ordinary attention, LoRA names, library paths and escaped brackets are unchanged', () => {
  for (const text of ['(tag:1.3), <lora:x.y:0.8>', '[folder.class.subclass.block]', '\\[tag, :0.2,0.8\\]', '<lora:a[b]:0.9>']) {
    assert.equal(scheduleSource(text).source, text);
  }
});

test('nested Prompt Control intervals translate recursively; invalid intervals are rejected', () => {
  assert.equal(scheduleSource('[[tag, :0.2,0.8], :0.3,0.7]').source,
    '{ { tag }.set{schedule: {0.2, 0.8}} }.set{schedule: {0.3, 0.7}}');
  for (const text of ['[tag, :0.8,0.2]', '[tag, :-0.1,0.8]', '[tag, :0,1.1]']) assert.throws(() => scheduleSource(text), /Schedule/);
});

test('new prompt text accepts both the full Prompt Control interval and schedule-free attention', () => {
  assert.equal(scheduleSource('[tag, :0,1]').source, '{ tag }.set{schedule: {0, 1}}');
  assert.equal(scheduleSource('[tag:0.2,0.8]').source, '{ tag }.set{schedule: {0.2, 0.8}}');
  assert.equal(scheduleSource('(tag:1.2)').source, '(tag:1.2)');
});

test('legacy Region and actual user-created blocks remain block source, preserving their settings', () => {
  const { row, source } = wrapper();
  assert.equal(promptDisplay({ ...row, settings: { ...row.settings, region: { kind: 'base' } } }, source).text, source);
  assert.equal(promptDisplay({ ...row, meta: { name: 'Named block' } }, source).text, source);
});

const python = process.env.PLV4_TEST_PYTHON;
function backend(operation, body) {
  const script = `import json,sys
from prompt_library_v4.model import EditorState,projection
from prompt_library_v4.commands import command_response
from prompt_library_v4.compiler import compile_document
value=json.load(sys.stdin); body=value['body']; op=value['operation']
state=EditorState.create(text=body['text']) if op=='open' else EditorState.from_json(body['state'])
if op=='open': result={'state':state.to_json(),'projection':projection(state)}
elif op=='command': result=command_response(state,body['command'])
else: result=compile_document(state,seed=7,region_mode='couple')
print(json.dumps(result,ensure_ascii=True))`;
  const result = spawnSync(python, ['-c', script], { input: JSON.stringify({ operation, body }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('the real run/backend preserve prompt IDs, parked siblings, compiled schedules and undo inside a schedule subblock', { skip: !python }, async () => {
  const { DocumentSession } = await load(await readFile(new URL('../../js/plv4/document_session.js', import.meta.url), 'utf8'));
  const snapshot = backend('open', { text: '[@schedule]: { 0 - 0.35: { { sunrise colors, fine details, parked } }, 0.35 - 1: { sunset } }' });
  const session = new DocumentSession(snapshot, { request: async (operation, body) => backend(operation, body) });
  const indexTree = tree => { const map = new Map(); const walk = n => { if (!n) return; map.set(n.id, n); n.children.forEach(walk); }; walk(tree); return map; };
  let rows = [...indexTree(session.projection.tree).values()];
  const leaf = rows.find(n => n.source === 'sunrise colors'), parked = rows.find(n => n.source === 'parked');
  await session.dispatch({ type: 'SetEnabled', id: parked.id, enabled: false });
  await session.dispatch({ type: 'SetPromptSettings', id: leaf.id, patch: { weight: 1.1, schedule: [.1, .3] } });
  const parent = indexTree(session.projection.tree).get(leaf.parent_id);
  globalThis.promptTextIntegration = { helpers, indexTree };
  const setup = `const { helpers: { promptDisplay, displayRun, scheduleSource, runEnd }, indexTree } = globalThis.promptTextIntegration;`;
  const view = (await readFile(new URL('../../js/plv4/block_view.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace('class RunSession', 'export class RunSession');
  const { RunSession } = await load(setup + view);
  const run = new RunSession(session, parent.children.map(n => n.id), { undo: () => session.undo(), redo: () => session.redo() });
  const before = session.text;
  assert.ok(run.text.includes('[(sunrise colors:1.1):0.1,0.3]'));
  assert.ok(!run.text.includes('.set'));
  await run.replaceText(run.text.replace('sunrise colors:1.1', 'golden sunrise:1.25'));
  assert.equal(indexTree(session.projection.tree).get(leaf.id).source, 'golden sunrise');
  assert.equal(indexTree(session.projection.tree).get(parked.id).enabled, false);
  assert.equal(indexTree(session.projection.tree).get(parked.id).source, 'parked');
  const compiled = backend('compile', { state: session.state });
  assert.ok(compiled.prompt.includes('(golden sunrise:1.25)') && compiled.prompt.includes(':0.1,0.3]'), compiled.prompt);
  assert.ok(!compiled.prompt.includes('parked'));
  const start = run.text.indexOf('golden sunrise');
  assert.equal(session.text.slice(run.sourceOffset(start), run.sourceOffset(start + 'golden sunrise'.length)), 'golden sunrise');
  await run.undo(); assert.equal(session.text, before);
  await run.redo(); assert.ok(session.text.includes('golden sunrise'));
  const reopened = new RunSession(session, parent.children.map(n => n.id), { undo: () => session.undo(), redo: () => session.redo() });
  assert.ok(reopened.text.includes('[(golden sunrise:1.25):0.1,0.3]'));
  await session.dispatch({ type: 'SetPromptSettings', id: leaf.id, patch: { weight: 1.5 } });
  const changed = backend('compile', { state: session.state }).prompt;
  assert.ok(changed.includes('(golden sunrise:1.5)') && !changed.includes(':1.25'), changed);
});

test('Block UI projects PLv3 separator layout while preserving source and caret mappings on edits', () => {
  const source = 'fantasy landscape,\r\n\t    detailed illustration';
  const start = source.indexOf('detailed');
  const rows = [{ source: 'fantasy landscape', span: [0, 17], effective: true },
    { source: 'detailed illustration', span: [start, source.length], effective: true }];
  const display = displayRun(rows, source, 0, source.length);
  assert.equal(display.text, 'fantasy landscape, detailed illustration');
  assert.equal(display.offsets[display.text.indexOf('detailed')], start);
  assert.equal(scheduleSource(display.text, display.originals, display).source, source);
  const changed = display.text.replace('fantasy', 'cinematic');
  const decoded = scheduleSource(changed, display.originals, display);
  assert.equal(decoded.source, source.replace('fantasy', 'cinematic'));
  assert.equal(decoded.source.slice(decoded.offsets[changed.indexOf('detailed')]), 'detailed illustration');
  const changedTail = display.text.replace('illustration', 'painting');
  assert.equal(scheduleSource(changedTail, display.originals, display).source, source.replace('illustration', 'painting'));
  const changedGap = display.text.replace(', ', ',\n');
  assert.equal(scheduleSource(changedGap, display.originals, display).source, changedGap, 'explicit separator edits must be accepted');
});

test('native Enter line breaks remain visible beside projected PLv3 indentation', () => {
  for (const gap of [',\n', ', \n', ',\n    \n']) {
    const source = 'tag' + gap + 'tail', at = source.indexOf('tail');
    const display = displayRun([{ effective: true, span: [0, 3] }, { effective: true, span: [at, source.length] }], source, 0, source.length);
    assert.ok(display.text.includes('\n'), 'an explicit unindented newline must survive');
    assert.equal(scheduleSource(display.text, display.originals, display).source, source);
  }
});

test('the real Region block run hides indentation after reload and edits preserve source, IDs and history', { skip: !python }, async () => {
  const { DocumentSession } = await load(await readFile(new URL('../../js/plv4/document_session.js', import.meta.url), 'utf8'));
  const source = '[@region]: {\n    [base]: {\n        fantasy landscape,\n        detailed illustration\n    }\n    [fill]: {\n        soft mist\n    }\n}';
  const session = new DocumentSession(backend('open', { text: source }), { request: async (op, body) => backend(op, body) });
  assert.equal(session.valid, true);
  const indexTree = tree => { const map = new Map(); const visit = row => { map.set(row.id, row); row.children.forEach(visit); }; visit(tree); return map; };
  const map = indexTree(session.projection.tree), tag = [...map.values()].find(row => row.source === 'fantasy landscape');
  const owner = map.get(tag.parent_id), ids = owner.children.map(row => row.id);
  globalThis.regionRunFixture = { helpers, indexTree };
  const viewSource = (await readFile(new URL('../../js/plv4/block_view.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace('class RunSession', 'export class RunSession');
  const { RunSession } = await load('const { helpers: { promptDisplay, displayRun, scheduleSource, runEnd }, indexTree } = globalThis.regionRunFixture;\n' + viewSource);
  const run = new RunSession(session, ids, {});
  assert.equal(run.text, 'fantasy landscape, detailed illustration');
  assert.equal(session.text, source);
  assert.equal(run.sourceOffset(run.text.indexOf('detailed')), source.indexOf('detailed'));
  await run.replaceText(run.text.replace('fantasy', 'cinematic'));
  assert.equal(session.text, source.replace('fantasy', 'cinematic'));
  await run.replaceText(run.text.replace('illustration', 'painting'));
  const edited = source.replace('fantasy', 'cinematic').replace('illustration', 'painting');
  assert.equal(session.text, edited);
  assert.deepEqual(indexTree(session.projection.tree).get(owner.id).children.map(row => row.id), ids);
  const reopened = new RunSession(session, ids, {});
  assert.equal(reopened.text, 'cinematic landscape, detailed painting');
  await session.undo(); await session.undo(); assert.equal(session.text, source);
  await session.redo(); await session.redo(); assert.equal(session.text, edited);
});

test('real PLv3 trailing newlines survive Block run reopen and further editing without multiplying layout', {skip:!python},async()=>{
  const {DocumentSession}=await load(await readFile(new URL('../../js/plv4/document_session.js',import.meta.url),'utf8'));
  const indexTree=tree=>{const map=new Map();const visit=n=>{map.set(n.id,n);n.children.forEach(visit);};visit(tree);return map;};
  globalThis.newlineRunFixture={helpers,indexTree};
  const view=(await readFile(new URL('../../js/plv4/block_view.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace('class RunSession','export class RunSession');
  const {RunSession}=await load('const {helpers:{promptDisplay,displayRun,scheduleSource,runEnd},indexTree}=globalThis.newlineRunFixture;\n'+view);
  for(const source of ['{ cat }','{\n    cat\n}','{ {\n        cat\n    }, tail }']){
    const session=new DocumentSession(backend('open',{text:source}),{request:async(op,body)=>backend(op,body)});
    const leaf=[...indexTree(session.projection.tree).values()].find(n=>n.source==='cat');
    const run=new RunSession(session,[leaf.id],{});await run.replaceText(run.text+'\n\n');
    const entered=session.text;assert.ok(entered.includes('cat\n\n'));
    const reopened=new RunSession(session,[leaf.id],{});assert.ok(reopened.text.startsWith('cat\n\n'));
    await reopened.replaceText(reopened.text);assert.equal(session.text,entered,'reopening must not duplicate a newline or closing-brace space');
    await reopened.replaceText(reopened.text.replace('cat','dog'));assert.equal(session.text,entered.replace('cat','dog'));
    await session.undo();assert.equal(session.text,entered);await session.undo();assert.equal(session.text,source);
    await session.redo();assert.equal(session.text,entered);assert.ok(session.valid);
  }
});

test('Settings prompt switches preserve Enter lines through the real backend, Block reopen and history', {skip:!python},async()=>{
  const {DocumentSession}=await load(await readFile(new URL('../../js/plv4/document_session.js',import.meta.url),'utf8'));
  const indexTree=tree=>{const map=new Map();const visit=n=>{map.set(n.id,n);n.children.forEach(visit);};visit(tree);return map;};
  globalThis.switchNewlineFixture={helpers,indexTree};
  const view=(await readFile(new URL('../../js/plv4/block_view.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace('class RunSession','export class RunSession');
  const {RunSession}=await load('const {helpers:{promptDisplay,displayRun,scheduleSource,runEnd},indexTree}=globalThis.switchNewlineFixture;\n'+view);
  const session=new DocumentSession(backend('open',{text:'{\n    first,\n    second\n}'}),{request:async(op,body)=>backend(op,body)});
  session.state.doc.root.meta={...session.state.doc.root.meta,_layout_indent:4};
  const owner=session.projection.tree.children[0],ids=owner.children.map(n=>n.id);
  const run=new RunSession(session,ids,{});await run.replaceText('first,\n\nsecond\n\n');
  const source=session.text;const before=new RunSession(session,ids,{}).text;
  await session.dispatch({type:'SetEnabled',id:ids[0],enabled:false});
  assert.ok(new RunSession(session,ids,{}).text.endsWith('second\n\n'),'turning off a sibling keeps the terminal empty lines');
  await session.dispatch({type:'SetEnabled',id:ids[0],enabled:true});
  assert.equal(session.text,source);assert.equal(new RunSession(session,ids,{}).text,before);
  await session.undo();await session.undo();assert.equal(session.text,source);
  await session.redo();await session.redo();assert.equal(session.text,source);
  assert.equal(new RunSession(session,ids,{}).text,before);
});

test('deleting Region subblock terminal blank lines stays deleted after reopen and restores exactly through undo', {skip:!python},async()=>{
  const {DocumentSession}=await load(await readFile(new URL('../../js/plv4/document_session.js',import.meta.url),'utf8'));
  const indexTree=tree=>{const map=new Map();const visit=n=>{map.set(n.id,n);n.children.forEach(visit);};visit(tree);return map;};
  globalThis.deleteNewlineFixture={helpers,indexTree};
  const view=(await readFile(new URL('../../js/plv4/block_view.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace('class RunSession','export class RunSession');
  const {RunSession}=await load('const {helpers:{promptDisplay,displayRun,scheduleSource,runEnd},indexTree}=globalThis.deleteNewlineFixture;\n'+view);
  for(const source of [
    '[@region]: { [base]: { landscape } [mask: [0, 0.5, 0, 1]]: { 1girl, emerald cloak\n\n } [fill]: { mist } }',
    '[@region]: {\n    [base]: { landscape }\n    [mask: [0, 0.5, 0, 1]]: {\n        1girl, emerald cloak\n\n\n    }\n    [fill]: { mist }\n}',
  ]){
    const session=new DocumentSession(backend('open',{text:source}),{request:async(op,body)=>backend(op,body)});
    const leaf=[...indexTree(session.projection.tree).values()].find(n=>n.source==='emerald cloak');
    const owner=indexTree(session.projection.tree).get(leaf.parent_id),ids=owner.children.map(n=>n.id);
    const compiled=backend('compile',{state:session.state});let edits=0;
    while(true){
      const run=new RunSession(session,ids,{});
      if(!/\n/.test(run.text))break;
      assert.ok(++edits<=3,'closing layout must never become an endlessly regenerated blank line');
      await run.replaceText(run.text.replace(/\r?\n[ \t]*$/,''));
    }
    assert.equal(new RunSession(session,ids,{}).text,'1girl, emerald cloak');
    assert.deepEqual(indexTree(session.projection.tree).get(owner.id).children.map(n=>n.id),ids);
    const after=backend('compile',{state:session.state});
    assert.equal(after.prompt,compiled.prompt,'whitespace deletion cannot move Region declarations');
    assert.equal(after.plain,compiled.plain,'whitespace deletion cannot change the plain prompt');
    const deleted=session.text;
    for(let i=0;i<edits;i++)await session.undo();assert.equal(session.text,source);
    for(let i=0;i<edits;i++)await session.redo();assert.equal(session.text,deleted);
    assert.equal(new RunSession(session,ids,{}).text,'1girl, emerald cloak');
  }
});

test('the existing TagAC token reader still completes and resolves tags inside PC intervals', async () => {
  const tagac = await readFile(new URL('../../js/tagac.js', import.meta.url), 'utf8');
  const tokenCode = tagac.slice(tagac.indexOf('function _tokenStart'), tagac.indexOf('// ─── Insertion text builders'));
  const { getPartialTag, getTokenAtCaret } = await load('const _acVal = el => el.value; const _acCaret = el => el.selectionStart;\n' + tokenCode + '\nexport { getPartialTag, getTokenAtCaret };');
  for (const text of ['[sunrise colors:0.2,0.8], fine details', '[(sunrise colors:1.1):0.2,0.8], fine details']) {
    const masked = autocompleteText(text);
    assert.equal(masked.length, text.length);
    assert.equal(masked.indexOf('sunrise colors'), text.indexOf('sunrise colors'));
    const field = { value: masked, selectionStart: text.indexOf('colors') + 2 };
    assert.equal(getPartialTag(field), 'sunrise_co');
    assert.equal(getTokenAtCaret(field), 'sunrise_colors');
  }
  assert.equal(autocompleteText('[folder.class.block]'), '[folder.class.block]');
});

test('typing a new Prompt Control range is editable after reopen, and an incomplete range can be repaired', { skip: !python }, async () => {
  const { DocumentSession } = await load(await readFile(new URL('../../js/plv4/document_session.js', import.meta.url), 'utf8'));
  const session = new DocumentSession(backend('open', { text: '{ tag, tail }' }), { request: async (op, body) => backend(op, body) });
  const indexTree = tree => { const map = new Map(); const walk = n => { if (!n) return; map.set(n.id, n); n.children.forEach(walk); }; walk(tree); return map; };
  globalThis.promptTextNewRange = { helpers, indexTree };
  const setup = `const { helpers: { promptDisplay, displayRun, scheduleSource, runEnd }, indexTree } = globalThis.promptTextNewRange;`;
  const view = (await readFile(new URL('../../js/plv4/block_view.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace('class RunSession', 'export class RunSession');
  const { RunSession } = await load(setup + view);
  const owner = session.projection.tree.children[0];
  const run = new RunSession(session, owner.children.map(n => n.id), {});
  await run.replaceText('[(tag:1.2):0.2,0.8], tail');
  let root = indexTree(session.projection.tree).get(owner.id);
  assert.equal(root.children[0].meta.presentation, 'prompt');
  const reopened = new RunSession(session, root.children.map(n => n.id), {});
  assert.equal(reopened.text, '[(tag:1.2):0.2,0.8], tail');
  await reopened.replaceText('[(tag:1.2):0.2,0.8');
  assert.equal(session.valid, false);
  await reopened.replaceText('[(new tag:1.2):0.2,0.8], tail');
  assert.equal(session.valid, true);
  root = indexTree(session.projection.tree).get(owner.id);
  assert.equal(root.children[0].meta.presentation, 'prompt');
  assert.equal(root.children[0].children[0].source, 'new tag');
  assert.equal(root.children[1].source, 'tail');
});
