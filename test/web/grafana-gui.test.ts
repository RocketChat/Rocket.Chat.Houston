/** Job results refresh the document's allow-list after public monitoring attaches. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function gui(atLoad: string[] | null = null) {
  const closed: (() => void)[] = [];
  const reload = jest.fn();
  const nodes = {
    '#job-title': { textContent: '' },
    '#job-log': { append: jest.fn(), scrollTop: 0, scrollHeight: 0 },
    '#job-dialog': {
      addEventListener: jest.fn((_event: string, callback: () => void, options: unknown) => {
        expect(options).toEqual({ once: true });
        closed.push(callback);
      }),
    },
  };
  const ctx = {
    $: (selector: keyof typeof nodes) => nodes[selector],
    el: jest.fn(),
    loadRepros: jest.fn(async () => undefined),
    refreshDetail: jest.fn(),
    GRAFANAS_AT_LOAD: atLoad === null ? null : new Set(atLoad),
    originOf: (url: string) => new URL(url).origin,
  };
  const source = fs
    .readFileSync(path.resolve(__dirname, '../../data/webui/js/jobs.js'), 'utf8')
    .replace(/^import .*;$/mu, '')
    .replace(/^export .*;$/mu, '');
  const sandbox = vm.createContext({ ctx, location: { reload } });
  vm.runInContext(source, sandbox);
  const finish = vm.runInContext('finishJob', sandbox) as (
    job: Record<string, unknown>,
    failed: boolean,
    data: Record<string, unknown>,
  ) => void;
  return { finish, reload, closed, ctx };
}

describe('Grafana public URL regression: GUI reload', () => {
  it.each([
    { monitoring: true, grafana_url: 'https://rc.example.test/grafana' },
    { monitoring: { grafana_url: 'https://rc.example.test/grafana' } },
  ])('reloads after the successful result is closed: %j', (result) => {
    const { finish, reload, closed } = gui();
    finish({}, false, { result });
    expect(reload).not.toHaveBeenCalled();
    expect(closed).toHaveLength(1);
    closed[0]?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

it("reloads for a second monitored workspace's Grafana, on a port the page does not allow yet", () => {
  const { finish, closed, reload } = gui();
  finish({}, false, { result: { monitoring: true, grafana_url: 'http://localhost:5051' } });
  expect(closed).toHaveLength(1);
  closed[0]?.();
  expect(reload).toHaveBeenCalledTimes(1);
});

it('keeps loopback and failed results on the current page', () => {
  const { finish, closed, reload } = gui();
  finish({}, false, { result: { monitoring: true, grafana_url: 'http://localhost:5050' } });
  finish({}, false, {
    result: { monitoring: true, grafana_url: 'http://localhost:5050/grafana' },
  });
  finish({}, true, {
    result: { monitoring: true, grafana_url: 'https://rc.example.test/grafana' },
  });
  finish({}, false, { result: { grafana_url: 'https://rc.example.test/grafana' } });
  expect(closed).toEqual([]);
  expect(reload).not.toHaveBeenCalled();
});

it('reloads nothing for a Grafana the page was loaded allowing', () => {
  // Every job on a monitored workspace carries its Grafana, so a plain `up` of the second
  // monitored workspace asked for a reload each time, throwing away a half-filled dialog
  // (review 2026-10-31).
  const { finish, closed, reload } = gui(['http://localhost:5051', 'https://rc.example.test']);
  finish({}, false, { result: { monitoring: true, grafana_url: 'http://localhost:5051' } });
  finish({}, false, {
    result: { monitoring: true, grafana_url: 'https://rc.example.test/grafana' },
  });
  expect(closed).toEqual([]);
  expect(reload).not.toHaveBeenCalled();
  finish({}, false, { result: { monitoring: true, grafana_url: 'http://localhost:5052' } });
  expect(closed).toHaveLength(1);
});
