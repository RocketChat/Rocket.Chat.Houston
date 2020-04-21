#! /usr/bin/env node

const updateNotifier = require('update-notifier');
const program = require('commander');
const gitUrlParse = require('git-url-parse');
const path = require('path');
const fs = require('fs');
const git = require('simple-git/promise')(process.cwd());

const pkg = require('../package.json');
updateNotifier({pkg}).notify();

const logs = require('../src/logs');
const md = require('../src/md');
const setVersion = require('../src/set-version');

const getRepoInfo = async() => {
	const remote = await git.listRemote(['--get-url']);

	const info = gitUrlParse(remote);

	return {
		owner: info.organization,
		repo: info.name
	};
};

let customMarkdown = (data) => Promise.resolve(data);

const filePath = path.resolve(process.cwd(), './package.json');
const file = JSON.parse(fs.readFileSync(filePath));
if (!file.houston) {
	return;
}
const { houston } = file;

if (houston.markdown) {
	customMarkdown = require(path.resolve(process.cwd(), houston.markdown));
}

program
	.command('logs')
	.description('Generate history.json')
	.option('-h, --head_name <name>', 'Name of the new release. Will rename the current HEAD section')
	.option('-t, --min_tag <tag>', 'Minimum tag to scrap the history')
	.action(async function({head_name, min_tag}) {
		logs({ ...await getRepoInfo(), headName: head_name, minTag: min_tag });
	});

program
	.command('md')
	.description('Generate History.md from History.json')
	.action(async function() {
		md({ ...await getRepoInfo(), customMarkdown });
	});

program
	.command('release')
	.description('Release a new version')
	.action(async function() {
		setVersion(await getRepoInfo());
	});

program.parse(process.argv);
