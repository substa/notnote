const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../app/graph-view.js"), "utf8");
const helper = source.match(/export function autoExpandJournalTasks\(\) \{[\s\S]*?\n\}/)[0].replace("export ", "");

function expand({ enabled = true, journal = true, zoom = null, tasks = [] } = {}) {
  const state = { journalMode: journal, graphZoomId: zoom, taskView: null, taskSummaryIds: [] };
  vm.runInNewContext(`${helper}\nautoExpandJournalTasks();`, {
    state,
    currentSettings: () => ({ autoExpandTodayTasks: enabled }),
    taskDate: () => "2026-06-15",
    taskOverviewGroups: () => ({ today: tasks }),
    taskPersistenceId: (task) => task.id,
  });
  return state;
}

const scheduled = { id: "today", scheduled: "2026-06-15", done: false };

test("scheduled tasks expand the journal panel and retain the overview order", () => {
  const state = expand({ tasks: [scheduled, { id: "progress", scheduled: "" }] });
  assert.equal(state.taskView, "summary");
  assert.deepEqual(state.taskSummaryIds, ["today", "progress"]);
});

test("overdue unfinished tasks also expand the journal panel", () => {
  const state = expand({ tasks: [{ ...scheduled, scheduled: "2026-06-14" }] });
  assert.equal(state.taskView, "summary");
  assert.deepEqual(state.taskSummaryIds, ["today"]);
});

test("auto expansion requires the setting, journal view, and unfinished tasks due today or earlier", () => {
  for (const options of [
    { enabled: false, tasks: [scheduled] },
    { journal: false, tasks: [scheduled] },
    { zoom: "block", tasks: [scheduled] },
    { tasks: [] },
    { tasks: [{ ...scheduled, done: true }] },
    { tasks: [{ ...scheduled, done: true, scheduled: "2026-06-14" }] },
    { tasks: [{ ...scheduled, scheduled: "2026-06-16" }] },
    { tasks: [{ ...scheduled, scheduled: "" }] },
  ]) assert.equal(expand(options).taskView, null);
});
