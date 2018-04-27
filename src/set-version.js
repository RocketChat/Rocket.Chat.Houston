/* eslint object-shorthand: 0, prefer-template: 0 */

const path = require('path');
const fs = require('fs');
const semver = require('semver');
const inquirer = require('inquirer');
const git = require('simple-git/promise')(process.cwd());
const logs = require('./logs');
const octokit = require('@octokit/rest')();
const md = require('../src/md');

octokit.authenticate({
	type: 'token',
	token: process.env.GITHUB_TOKEN
});
const owner = 'RocketChat';
const repo = 'Rocket.Chat';

let pkgJson = {};

try {
	pkgJson = require(path.resolve(
		process.cwd(),
		'./package.json'
	));
} catch (err) {
	console.error('no root package.json found');
}

const files = [
	'./package.json',
	'./.sandstorm/sandstorm-pkgdef.capnp',
	'./.travis/snap.sh',
	'./.circleci/snap.sh',
	'./.circleci/update-releases.sh',
	'./.docker/Dockerfile',
	'./.docker/Dockerfile.rhel',
	'./packages/rocketchat-lib/rocketchat.info'
];
const readFile = (file) => {
	return new Promise((resolve, reject) => {
		fs.readFile(file, 'utf8', (error, result) => {
			if (error) {
				return reject(error);
			}
			resolve(result);
		});
	});
};
const writeFile = (file, data) => {
	return new Promise((resolve, reject) => {
		fs.writeFile(file, data, 'utf8', (error, result) => {
			if (error) {
				return reject(error);
			}
			resolve(result);
		});
	});
};

let selectedVersion;

git.status()
	.then(status => {
		if (status.current === 'release-candidate') {
			return inquirer.prompt([{
				type: 'confirm',
				message: 'Merge from develop?',
				name: 'merge'
			}])
				.then(answers => answers.merge && git.mergeFromTo('origin/develop', 'release-candidate'))
				.then(() => semver.inc(pkgJson.version, 'prerelease', 'rc'));
		}
		if (/release-\d+\.\d+\.\d+/.test(status.current)) {
			return semver.inc(pkgJson.version, 'patch');
		}
		if (status.current === 'develop-sync') {
			return semver.inc(pkgJson.version, 'minor') + '-develop';
		}
		return Promise.reject(`No release action for branch ${ status.current }`);
	})
	.then(nextVersion => inquirer.prompt([{
		type: 'list',
		message: `The current version is ${ pkgJson.version }. Update to version:`,
		name: 'version',
		choices: [
			nextVersion,
			'custom'
		]
	}]))
	.then(answers => {
		if (answers.version === 'custom') {
			return inquirer.prompt([{
				name: 'version',
				message: 'Enter your custom version:'
			}]);
		}
		return answers;
	})
	.then(({ version }) => {
		selectedVersion = version;
		return Promise.all(files.map(file => {
			return readFile(file)
				.then(data => {
					return writeFile(file, data.replace(pkgJson.version, version));
				});
		})).then(() => version);
	})
	.then((version) => {
		return logs({headName: version});
	})
	.then(() => {
		md();
		return inquirer.prompt([{
			type: 'confirm',
			message: 'Commit files?',
			name: 'commit'
		}]);
	})
	.then(answers => {
		if (!answers.commit) {
			return Promise.reject(answers);
		}

		return git.status();
	})
	.then(status => inquirer.prompt([{
		type: 'checkbox',
		message: 'Select files to commit?',
		name: 'files',
		choices: status.files.map(file => { return {name: `${ file.working_dir } ${ file.path }`, checked: true}; })
	}]))
	.then(answers => answers.files.length && git.add(answers.files.map(file => file.slice(2))))
	.then(() => git.commit(`Bump version to ${ selectedVersion }`))
	.then(() => inquirer.prompt([{
		type: 'confirm',
		message: `Add tag ${ selectedVersion }?`,
		name: 'tag'
	}]))
	.then(answers => answers.tag && git.addTag(selectedVersion))
	.then(() => inquirer.prompt([{
		type: 'confirm',
		message: 'Push branch?',
		name: 'pushBranch'
	}]))
	.then(answers => {
		return answers.pushBranch && git.status().then(status => {
			return git.push('origin', status.current);
		});
	})
	.then(() => inquirer.prompt([{
		type: 'confirm',
		message: 'Push tag?',
		name: 'pushTag'
	}]))
	.then(answers => answers.pushTag && git.push('origin', selectedVersion))
	.then(() => inquirer.prompt([{
		type: 'confirm',
		message: 'Set history to tag?',
		name: 'pushTag'
	}]))
	.then(answers => {
		const body = md({tag: selectedVersion, write: false, title: false});
		return answers.pushTag && octokit.repos.getReleaseByTag({owner, repo, tag: selectedVersion})
			.then((release) => octokit.repos.editRelease({owner, repo, id: release.data.id, tag_name: selectedVersion, body, name: selectedVersion, prerelease: selectedVersion.includes('-rc.')}));
	})
	.catch((error) => {
		console.error(error);
	});
