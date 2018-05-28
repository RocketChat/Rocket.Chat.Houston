#! /usr/bin/env node

const updateNotifier = require('update-notifier');
const pkg = require('../package.json');
updateNotifier({pkg}).notify();

const program = require('commander');
const logs = require('../src/logs');
const md = require('../src/md');

program
	.command('logs')
	.description('Generate history.json')
	.option('-h, --head_name <name>', 'Name of the new release. Will rename the current HEAD section')
	.action(function({head_name}) {
		logs({headName: head_name});
	});

program
	.command('md')
	.description('Generate History.md from History.json')
	.action(function() {
		md();
	});

program
	.command('release')
	.description('Release a new version')
	.action(function() {
		require('../src/set-version');
	});

program.parse(process.argv);
