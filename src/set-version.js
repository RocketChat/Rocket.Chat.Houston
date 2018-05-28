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

		if (!this.version) {
			this.readVersionFromPackageJson();
		}
	}

	readVersionFromPackageJson() {
		const filePath = path.resolve(process.cwd(), './package.json');
		const file = JSON.parse(fs.readFileSync(filePath));
		this.version = file.version;
	}

	async init() {
		if (!await this.isClean()) {
			throw new Error('Branch not synced or changes in files. Please run this only on clean stage.');
		}

		await this.getRemote();
		await this.selectAction();
	}

	async isClean() {
		const {files, ahead, behind} = await git.status();
		return files.length === 0 && ahead === 0 && behind === 0;
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

	async currentBranch() {
		const {current} = await git.status();
		return current;
	}

	async selectAction() {
		const branch = await this.currentBranch();
		let defaultOption;

		if (branch === 'release-candidate') {
			defaultOption = 'release-candidate';
		}

		if (branch === 'master') {
			defaultOption = 'develop-sync';
		}

		if (/release-\d+\.\d+\.\d+/.test(branch)) {
			defaultOption = 'release';
		}

		if (branch === 'develop-sync') {
			defaultOption = 'develop-sync';
		}

		const { answer } = await inquirer.prompt([{
			type: 'list',
			message: 'Which action you want to execute?',
			name: 'answer',
			default: defaultOption,
			choices: [{
				name: 'Release Candidate', value: 'release-candidate'
			}, {
				name: 'Final Release', value: 'release'
			}, {
				name: 'Develop Sync', value: 'develop-sync'
			}]
		}]);

		if (answer === 'release-candidate') {
			return await this.newReleaseCandidate();
		}

		if (answer === 'release') {
			return await this.newFinalRelease();
		}

		if (answer === 'develop-sync') {
			return await this.newSyncRelease();
		}

		throw new Error(`No release action for branch ${ status.current }`);
	}

	async newReleaseCandidate() {
		// @TODO Allow start from develop and ask for create the release-candidate branch
		await this.goToBranch({branch: 'release-candidate', readVersion: true});
		await this.shouldMergeFromTo({from: 'origin/develop', to: 'release-candidate'});
		await this.selectVersionToUpdate({currentVersion: this.version, release: 'prerelease', identifier: 'rc'});
		await this.updateVersionInFiles();
		await this.updateHistory();
		await this.shouldPushCurrentBranch();
		await this.shouldAddTag();
		await this.shouldSetHistoryToGithubRelease();
	}

	async newFinalRelease() {
		await this.goToBranch({branch: 'release-candidate', readVersion: true});
		await this.selectVersionToUpdate({currentVersion: this.version, release: 'patch'});
		await this.goToBranch({branch: 'master'});
		await this.pull();
		await this.createAndGoToBranch({branch: `release-${ this.version }`});
		try {
			await this.shouldMergeFromTo({from: 'origin/release-candidate', to: `release-${ this.version }`});
		} catch (error) {
			console.log('Error while merging, please do it manually');
			console.error(error);
		}
		await this.updateVersionInFiles();
		await this.updateHistory();
		await this.shouldPushCurrentBranch();
		await this.shouldCreateDraftReleaseWithHistory();
		await this.shouldCreateReleasePullRequest();
	}

	async newSyncRelease() {
		await this.goToBranch({branch: 'master', readVersion: true});
		await this.createAndGoToBranch({branch: 'develop-sync'});
		// @TODO Allow run from master and create the branch develop-sync
		// await this.shouldMergeFromTo({from: 'origin/master', to: 'develop-sync'});
		await this.selectVersionToUpdate({currentVersion: this.version, release: 'minor', suffix: '-develop'});
		await this.updateVersionInFiles();
		await this.updateHistory();
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

	async goToBranch({branch, readVersion = false}) {
		const currentBranch = await this.currentBranch();
		if (currentBranch !== branch) {
			console.log('Switching to branch', branch);
			await git.checkout(branch);
			if (readVersion) {
				this.readVersionFromPackageJson();
			}
		}
	}

	async pull() {
		await git.pull();
	}

	async createAndGoToBranch({branch}) {
		const branchs = (await git.branchLocal()).all;
		if (branchs.includes(branch)) {
			const answers = await inquirer.prompt([{
				type: 'confirm',
				message: `Branch ${ branch } already exists, should delete and recreate?`,
				name: 'deleteBranch'
			}]);

			if (answers.deleteBranch) {
				console.log('Deleting branch', branch);
				await git.deleteLocalBranch(branch);
			} else {
				await this.goToBranch({branch});
			}
		} else {
			console.log('Creating branch', branch);
			await git.checkoutLocalBranch(branch);
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
			message: `The current version is ${ this.version }. Update to version:`,
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
		this.oldVersion = this.version;
		this.version = version;
		return version;
	}

	async updateVersionInFiles() {
		await Promise.all(files.map(async(file) => {
			let data = await readFile(file, 'utf8');
			data = data.replace(this.oldVersion, this.version);
			if (file.includes('sandstorm-pkgdef.capnp')) {
				data = data.replace(/appVersion\s=\s(\d+),\s\s#\sIncrement/, (s, number) => {
					number = parseInt(number, 10);
					return s.replace(number, ++number);
				});
			}
			return await writeFile(file, data, 'utf8');
		}));

		await this.shouldCommitFiles();
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

	async shouldCreateReleasePullRequest() {
		const answers = await inquirer.prompt([{
			type: 'confirm',
			message: `Create a GitHub Pull Request for release "${ this.version }"?`,
			name: 'create'
		}]);

		const body = md({tag: this.version, write: false, title: false});
		if (answers.create) {
			console.log('Creating pull request');
			await octokit.pullRequests.create({
				owner: this.owner,
				repo: this.repo,
				title: `Release ${ this.version }`,
				head: await this.currentBranch(),
				base: 'master',
				body
			});
		}
	}
}

const houston = new Houston();
houston.init().catch(error => console.error(error));
