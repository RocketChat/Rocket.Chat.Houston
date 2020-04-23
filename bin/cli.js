#! /usr/bin/env node

const updateNotifier = require('update-notifier');
const program = require('commander');
const path = require('path');
const gitUrlParse = require('git-url-parse');
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

let getMetadata = () => Promise.resolve({});

try {
	getMetadata = require(path.resolve(process.cwd(), '.houston/metadata.js'));
} catch (e) {
	//
}

program
	.command('logs')
	.description('Generate history.json')
	.option('-h, --head_name <name>', 'Name of the new release. Will rename the current HEAD section')
	.option('-t, --min_tag <tag>', 'Minimum tag to scrap the history')
	.action(async function({head_name, min_tag}) {
		logs({ ...await getRepoInfo(), headName: head_name, minTag: min_tag, getMetadata });
	});

program
	.command('md')
	.description('Generate History.md from History.json')
	.action(async function() {
		md({ ...await getRepoInfo() });
	});

program
	.command('release')
	.description('Release a new version')
	.action(async function() {
		setVersion(await getRepoInfo(), getMetadata);
	});

program.parse(process.argv);
