const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
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

let pkgJson = {};

try {
	pkgJson = require(path.resolve(process.cwd(), './package.json'));
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

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

class Houston {
	constructor({
		owner,
		repo,
		version
	} = {}) {
		this.owner = owner;
		this.repo = repo;
		this.version = version;
	}

	async init() {
		await this.getRemote();
		await this.selectAction();
	}

	async getRemote() {
		if (this.owner && this.repo) {
			return;
		}

		let remotes = await git.listRemote(['--get-url']);
		remotes = remotes.split(/\n/);

		if (remotes.length === 0) {
			throw new Error('No git remote found');
		}

		const [, owner, repo] = remotes[0].match(/\/([^\/]+)\/([^\/]+)\.git$/);
		this.owner = owner;
		this.repo = repo;
	}

	async selectAction() {
		const status = await git.status();

		if (status.current === 'release-candidate') {
			return await this.newReleaseCandidate();
		}

		if (/release-\d+\.\d+\.\d+/.test(status.current)) {
			return await this.newFinalRelease();
		}

		if (status.current === 'develop-sync') {
			return await this.newSyncRelease();
		}

		throw new Error(`No release action for branch ${ status.current }`);
	}

	async newReleaseCandidate() {
		await this.shouldMergeFromTo({from: 'origin/develop', to: 'release-candidate'});
		await this.selectVersionToUpdate({currentVersion: pkgJson.version, release: 'prerelease', identifier: 'rc'});
		await this.shouldPushCurrentBranch();
		await this.shouldAddTag();
		await this.shouldSetHistoryToGithubRelease();
	}

	async newFinalRelease() {
		await this.selectVersionToUpdate({currentVersion: pkgJson.version, release: 'patch'});
		await this.shouldPushCurrentBranch();
		await this.shouldCreateDraftReleaseWithHistory();
	}

	async newSyncRelease() {
		// @TODO Allow run from master and create the branch develop-sync
		await this.shouldMergeFromTo({from: 'origin/master', to: 'develop-sync'});
		await this.selectVersionToUpdate({currentVersion: pkgJson.version, release: 'minor', suffix: '-develop'});
		await this.shouldPushCurrentBranch();
	}

	async shouldPushTag() {
		const answers = await inquirer.prompt([{
			type: 'confirm',
			message: 'Push tag?',
			name: 'pushTag'
		}]);

		return answers.pushTag && await git.push('origin', this.version);
	}

	async shouldPushCurrentBranch() {
		const status = await git.status();

		const answers = await inquirer.prompt([{
			type: 'confirm',
			message: `Push ${ status.current } branch?`,
			name: 'pushBranch'
		}]);

		return answers.pushBranch && await git.push('origin', status.current);
	}

	async shouldAddTag() {
		const answers = await inquirer.prompt([{
			type: 'confirm',
			message: `Add tag ${ this.version }?`,
			name: 'tag'
		}]);

		if (answers.tag) {
			await git.addTag(this.version);
			await this.shouldPushTag();
		}
	}

	async shouldMergeFromTo({from, to}) {
		const answers = await inquirer.prompt([{
			type: 'confirm',
			message: `Merge from ${ from }?`,
			name: 'merge'
		}]);

		return answers.merge && await git.mergeFromTo(from, to);
	}

	async selectVersionToUpdate({currentVersion, release, identifier, suffix = ''}) {
		const nextVersion = semver.inc(currentVersion, release, identifier) + suffix;
		let answers = await inquirer.prompt([{
			type: 'list',
			message: `The current version is ${ pkgJson.version }. Update to version:`,
			name: 'version',
			choices: [
				nextVersion,
				'custom'
			]
		}]);

		if (answers.version === 'custom') {
			answers = await inquirer.prompt([{
				name: 'version',
				message: 'Enter your custom version:'
			}]);
		}

		const { version } = answers;
		this.version = version;

		await this.updateVersionInFiles();
		await this.shouldCommitFiles();
		await this.updateHistory();
	}

	async updateVersionInFiles() {
		await Promise.all(files.map(async(file) => {
			let data = await readFile(file, 'utf8');
			data = data.replace(pkgJson.version, this.version);
			if (file.includes('sandstorm-pkgdef.capnp')) {
				data = data.replace(/appVersion\s=\s(\d+),\s\s#\sIncrement/, (s, number) => {
					number = parseInt(number, 10);
					return s.replace(number, ++number);
				});
			}
			return await writeFile(file, data, 'utf8');
		}));
	}

	async updateHistory() {
		await logs({headName: this.version/*, owner: this.owner, repo: this.repo*/});
		md();
		await this.shouldCommitFiles({amend: true});
	}

	async shouldCommitFiles({amend = false} = {}) {
		let answers = await inquirer.prompt([{
			type: 'confirm',
			message: 'Commit files?',
			name: 'commit'
		}]);

		if (!answers.commit) {
			return;
		}

		const status = await git.status();

		answers = await inquirer.prompt([{
			type: 'checkbox',
			message: 'Select files to commit?',
			name: 'files',
			choices: status.files.map(file => { return {name: `${ file.working_dir } ${ file.path }`, checked: true}; })
		}]);

		if (answers.files.length) {
			await git.add(answers.files.map(file => file.slice(2)));

			const options = [];

			if (amend) {
				options.push('--amend');
			}

			await git.commit(`Bump version to ${ this.version }`, options);
		}
	}

	async shouldSetHistoryToGithubRelease() {
		const answers = await inquirer.prompt([{
			type: 'confirm',
			message: 'Set history to tag?',
			name: 'pushTag'
		}]);

		const body = md({tag: this.version, write: false, title: false});
		if (answers.pushTag) {
			try {
				const release = await octokit.repos.getReleaseByTag({owner: this.owner, repo: this.repo, tag: this.version});
				console.log('Editing release');
				await octokit.repos.editRelease({
					owner: this.owner,
					repo: this.repo,
					id: release.data.id,
					tag_name: this.version,
					body,
					name: this.version,
					prerelease: this.version.includes('-rc.')
				});
			} catch (error) {
				if (error.code === 404) {
					console.log('Creating release');
					await octokit.repos.createRelease({
						owner: this.owner,
						repo: this.repo,
						tag_name: this.version,
						name: this.version,
						body,
						draft: false,
						prerelease: this.version.includes('-rc.')
					});
				} else {
					throw error;
				}
			}
		}
	}

	async shouldCreateDraftReleaseWithHistory({branch = 'master'} = {}) {
		const answers = await inquirer.prompt([{
			type: 'confirm',
			message: `Create a GitHub draft release "${ this.version }"?`,
			name: 'create'
		}]);

		const body = md({tag: this.version, write: false, title: false});
		if (answers.create) {
			console.log('Creating draft release');
			await octokit.repos.createRelease({
				owner: this.owner,
				repo: this.repo,
				tag_name: this.version,
				target_commitish: branch,
				name: this.version,
				body,
				draft: true,
				prerelease: this.version.includes('-rc.')
			});
		}
	}
}

const houston = new Houston();
try {
	houston.init();
} catch (error) {
	console.log(error);
}
