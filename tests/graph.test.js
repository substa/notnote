const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const context = { crypto: webcrypto };
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL('../graph.js', `file://${__filename}`), 'utf8'), context);
const Graph = context.NotnoteGraph;

test('parses and serializes nested Logseq blocks', () => {
  const markdown = 'title:: Project\n\n- parent [[Other]]\n  id:: abcdefgh-1234\n  - child\n- TODO next\n';
  const document = Graph.parseDocument(markdown);

  assert.equal(document.preamble[0], 'title:: Project');
  assert.equal(document.blocks.length, 2);
  assert.equal(document.blocks[0].id, 'abcdefgh-1234');
  assert.equal(document.blocks[0].children[0].content, 'child');
  assert.equal(Graph.serializeDocument(document), markdown);
});

test('does not serialize the transient new-block placeholder', () => {
  const document = Graph.parseDocument('- existing\n');
  document.blocks.push({
    id: 'placeholder',
    content: '',
    marker: '-',
    children: [],
    transient: true,
  });

  assert.equal(Graph.serializeDocument(document), '- existing\n');

  const preambleOnly = Graph.parseDocument('title:: Notes\n');
  preambleOnly.blocks.push({ ...document.blocks.at(-1), id: 'preamble-placeholder' });
  assert.equal(Graph.serializeDocument(preambleOnly), 'title:: Notes\n');
});

test('preserves Logseq task markers and scheduling metadata', () => {
  const markdown = '- TODO Prepare release\n  SCHEDULED: <2026-07-18 Sat>\n- NOW Review changes\n  DEADLINE: <2026-07-20 Mon>\n- DONE Publish\n';
  const document = Graph.parseDocument(markdown);

  assert.equal(document.blocks[0].content, 'TODO Prepare release\nSCHEDULED: <2026-07-18 Sat>');
  assert.equal(document.blocks[1].content, 'NOW Review changes\nDEADLINE: <2026-07-20 Mon>');
  assert.equal(document.blocks[2].content, 'DONE Publish');
  assert.equal(Graph.serializeDocument(document), markdown);
});

test('recognizes only blank generated page content as empty', () => {
  assert.equal(Graph.isEmptyPageContent(''), true);
  assert.equal(Graph.isEmptyPageContent('- \n'), true);
  assert.equal(Graph.isEmptyPageContent('*'), true);
  assert.equal(Graph.isEmptyPageContent('- actual text'), false);
  assert.equal(Graph.isEmptyPageContent('title:: Preserved\n\n- '), false);
});

test('keeps fenced code inside a single graph block', () => {
  const markdown = '- ```bash\n  echo "hello"\n  - this is code, not a child block\n  ```\n- next block\n';
  const document = Graph.parseDocument(markdown);

  assert.equal(document.blocks.length, 2);
  assert.equal(document.blocks[0].children.length, 0);
  assert.equal(document.blocks[0].content, '```bash\necho "hello"\n- this is code, not a child block\n```');
  assert.equal(Graph.serializeDocument(document), markdown);
});

test('keeps fenced code nested after text inside a graph block', () => {
  const markdown = '- real IP on access.log\n  ```bash\n  LogFormat "%{X-Forwarded-For}i" combined\n  - shell content\n  ```\n- next block\n';
  const document = Graph.parseDocument(markdown);

  assert.equal(document.blocks.length, 2);
  assert.equal(document.blocks[0].children.length, 0);
  assert.match(document.blocks[0].content, /real IP[\s\S]*```bash[\s\S]*LogFormat/);
  assert.equal(Graph.serializeDocument(document), markdown);
});

test('keeps Org quote contents inside a single graph block', () => {
  const markdown = '- #+BEGIN_QUOTE\n  quoted text\n  - quoted bullet\n  #+END_QUOTE\n- next block\n';
  const document = Graph.parseDocument(markdown);

  assert.equal(document.blocks.length, 2);
  assert.equal(document.blocks[0].children.length, 0);
  assert.match(document.blocks[0].content, /#\+BEGIN_QUOTE[\s\S]*quoted bullet[\s\S]*#\+END_QUOTE/);
  assert.equal(Graph.serializeDocument(document), markdown);
});

test('does not index shell conditionals in fenced code as page references', () => {
  const index = new Graph.GraphIndex([
    { title: 'Script', path: 'pages/script.md', content: '- ```bash\n  [[ -z "${VALUE}" ]] && echo empty\n  ```\n- [[Real page]]\n' }
  ]);

  assert.equal(index.pageSuggestions().some(page => page.title.includes('${VALUE}')), false);
  assert.equal(index.referencesToPage('Real page').length, 1);
});

test('does not index tags or references inside fenced code', () => {
  const index = new Graph.GraphIndex([
    {
      title: 'Examples',
      path: 'pages/examples.md',
      content: '- ```css\n  color: #000000;\n  ```\n- ```cron\n  #0 * * * * command\n  ```\n- #real-tag [[Real page]]\n',
    },
  ]);
  const suggestions = index.pageSuggestions().map(page => page.title);

  assert.equal(suggestions.includes('000000'), false);
  assert.equal(suggestions.includes('0'), false);
  assert.equal(suggestions.includes('real-tag'), true);
  assert.equal(index.referencesToPage('Real page').length, 1);
});

test('indexes page and block references', () => {
  const pages = [
    { title: 'Source', path: 'pages/source.md', content: '- See [[Alias]] and ((12345678-abcd))\n' },
    { title: 'Target', path: 'pages/target.md', content: 'alias:: [[Alias]]\n\n- Referenced\n  id:: 12345678-abcd\n' }
  ];
  const index = new Graph.GraphIndex(pages);

  assert.equal(index.referencesToPage('target').length, 1);
  assert.equal(index.resolvePage('Alias').title, 'Target');
  assert.equal(index.aliasesForPage(pages[1]).join(','), 'Alias');
  assert.equal(index.resolveBlock('12345678-abcd').page.title, 'Target');
  assert.equal(index.search('referenced').length, 1);
});

test('finds references to pages that have no Markdown file yet', () => {
  const index = new Graph.GraphIndex([
    { title: 'Meeting', path: 'pages/meeting.md', content: '- Meeting with [[Nome Cognome]]\n' }
  ]);

  assert.equal(index.resolvePage('Nome Cognome'), undefined);
  assert.equal(index.referencesToPage('Nome Cognome').length, 1);
  assert.deepEqual(index.pageSuggestions().find(page => page.title === 'Nome Cognome')?.virtual, true);
});

test('keeps every scanned page in the index when titles or aliases overlap', () => {
  const index = new Graph.GraphIndex([
    { title: 'Duplicate', path: 'pages/first.md', content: '- First unique block\n' },
    { title: 'Duplicate', path: 'pages/second.md', content: '- Second unique block\n' }
  ]);

  assert.equal(index.allPages().length, 2);
  assert.equal(index.search('second unique').length, 1);
});

test('ignores accidentally nested Logseq graph copies', () => {
  const index = new Graph.GraphIndex([
    { title: 'Source', path: 'pages/source.md', content: '- [[Target]]\n' },
    { title: 'Source', path: 'pages/pages/source.md', content: '- [[Target]]\n' },
    { title: 'Target', path: 'pages/target.md', content: '- Original\n' },
    { title: 'Target', path: 'pages/pages/target.md', content: '- Duplicate\n' },
    { title: 'Jul 21st, 2026', path: 'journals/2026_07_21.md', content: '- Journal\n', journal: true },
    { title: 'Jul 21st, 2026', path: 'journals/journals/2026_07_21.md', content: '- Duplicate journal\n', journal: true }
  ]);

  assert.equal(index.allPages().length, 3);
  assert.equal(index.referencesToPage('Target').length, 1);
  assert.equal(index.pageSuggestions().filter(page => page.title === 'Target').length, 1);
});

test('indexes namespaced page links and tags', () => {
  const pages = [
    { title: 'Source', path: 'pages/source.md', content: '- [[persone/nome]]\n- #persone/nome\n' },
    { title: 'nome', name: 'persone___nome.md', path: 'pages/persone___nome.md', content: '- Profile\n' }
  ];
  const index = new Graph.GraphIndex(pages);
  assert.equal(index.referencesToPage('persone/nome').length, 2);
  assert.equal(index.referencesToPage('nome').length, 2);
  assert.equal(index.resolvePage('persone___nome').title, 'nome');
  assert.equal(index.resolvePage('persone%2Fnome').title, 'nome');
  assert.equal(Graph.pageTitle('title:: nome', 'persone___nome.md'), 'persone/nome');
});

test('converts Logseq PDF embeds to regular attachment links', () => {
  const markdown = '- ![verbale Scala firmato.pdf](../assets/verbale_Scala_firmato_1784561924481_0.pdf)\n';
  const document = Graph.parseDocument(markdown);

  assert.equal(
    Graph.serializeDocument(document),
    '- [verbale Scala firmato.pdf](../assets/verbale_Scala_firmato_1784561924481_0.pdf)\n'
  );
});

test('resolves graph assets relative to the page folder', () => {
  assert.equal(Graph.resolveAssetPath('../assets/immagine.jpg', 'pages'), 'assets/immagine.jpg');
  assert.equal(Graph.resolveAssetPath('../assets/My%20image.jpg', 'journals'), 'assets/My image.jpg');
  assert.equal(Graph.resolveAssetPath('./images/image.jpg', 'pages/nested'), 'pages/nested/images/image.jpg');
});

test('preserves assets mentioned through raw, encoded, or non-standard links', () => {
  const path = 'assets/My image.png';

  assert.equal(Graph.contentMentionsAsset('- ![](../assets/My image.png)', path), true);
  assert.equal(Graph.contentMentionsAsset('- ![](../assets/My%20image.png)', path), true);
  const corpus = Graph.assetReferenceCorpus('<img src="/assets/My%20image.png">');
  assert.equal(Graph.contentMentionsAsset(corpus, path), true);
  assert.deepEqual(
    [...Graph.referencedAssetPaths(corpus, [path, 'assets/orphan.pdf'])],
    [path],
  );
  assert.equal(Graph.contentMentionsAsset('- no attachment here', path), false);
});

test('queues and synchronizes remote page writes while offline', async () => {
  const store = new Graph.RemoteGraphStore({ name: 'Remote' });
  store.cache = { status: { name: 'Remote' }, files: { files: [], config: {} }, operations: [] };
  store.offline = true;
  store.persistCache = async function () { this.pendingCount = this.cache.operations.length; };
  const page = { title: 'Offline', name: 'offline.md', path: 'pages/offline.md', folder: 'pages', content: '', lastModified: null };
  store.pages = [page];

  await store.writePage(page, '- local', { create: true });
  assert.equal(store.pendingCount, 1);
  assert.equal(store.cache.operations[0].create, true);
  assert.equal(store.cache.files.files[0].content, '- local');

  store.api = async () => ({ revision: '2' });
  assert.equal(await store.syncPending(), 1);
  assert.equal(store.pendingCount, 0);
  assert.equal(page.lastModified, '2');
  assert.equal(store.offline, false);
});

test('applies journal formats imported into graph settings', () => {
  const store = new Graph.GraphStore({ name: 'Notes' });
  store.applySettings({ journal: { fileNameFormat: 'yyyy-MM-dd', pageTitleFormat: 'MMMM do, yyyy' } });
  assert.equal(store.config.fileNameFormat, 'yyyy-MM-dd');
  assert.equal(store.config.pageTitleFormat, 'MMMM do, yyyy');
  assert.equal(store.settingsConfig, true);
});

test('uses Logseq-compatible journal date formats', () => {
  const date = new Date(2026, 6, 17);
  assert.equal(Graph.formatJournalDate(date, 'yyyy_MM_dd'), '2026_07_17');
  assert.equal(Graph.formatJournalDate(date, 'MMM do, yyyy'), 'Jul 17th, 2026');
  const parsed = Graph.parseJournalDate('2026_07_17.md', 'yyyy_MM_dd');
  assert.deepEqual([parsed.getFullYear(), parsed.getMonth(), parsed.getDate()], [2026, 6, 17]);
  const index = new Graph.GraphIndex([{ title: 'Jul 17th, 2026', path: 'journals/2026_07_17.md', journal: true, journalDate: '2026-07-17', content: '- entry' }]);
  assert.equal(index.resolvePage('2026_07_17').title, 'Jul 17th, 2026');
});

test('updates one page incrementally without losing overlapping page names', () => {
  const first = { title: 'First', path: 'pages/first.md', content: 'alias:: Shared\n\n- [[Old]]\n' };
  const second = { title: 'Second', path: 'pages/second.md', content: 'alias:: Shared\n\n- Keep me\n' };
  const index = new Graph.GraphIndex([first, second]);

  first.content = 'alias:: Shared\n\n- [[New]]\n';
  index.updatePage(first, first.content);

  assert.equal(index.referencesToPage('Old').length, 0);
  assert.equal(index.pageSuggestions().some(page => page.title === 'Old'), false);
  assert.equal(index.referencesToPage('New').length, 1);
  assert.equal(index.search('Keep me').length, 1);
  assert.equal(index.resolvePage('Shared').title, 'First');
});

test('updates page references without changing aliases', () => {
  const content = '- [[Old page]] and [[Old page|label]] and [[Other]]';
  assert.equal(
    Graph.replacePageReferences(content, 'Old page', 'New page'),
    '- [[New page]] and [[New page|label]] and [[Other]]'
  );
});

test('updates page-reference casing during a case-only rename', () => {
  const content = '- [[test]] and [[TEST|label]] and [[Other]]';
  assert.equal(
    Graph.replacePageReferences(content, 'test', 'Test'),
    '- [[Test]] and [[Test|label]] and [[Other]]'
  );
});
