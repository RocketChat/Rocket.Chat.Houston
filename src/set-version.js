const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const semver = require('semver');
const inquirer = require('inquirer');
const git = require('simple-git/promise')(process.cwd());
const logs = require('./logs');
const { Octokit } = require('@octokit/rest');
const md = require('../src/md');

const octokit = new Octokit({
	auth: process.env.GITHUB_TOKEN
});

const files = [];

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

const {
	PUSH_TAG_OPTIONS = '',
	PUSH_CURRENT_BRANCH_OPTIONS = ''
} = process.env;

class Houston {
	constructor({
		owner,
		repo,
		version,
		getMetadata
	} = {}) {
		this.owner = owner;
		this.repo = repo;
		this.version = version;
		this.minTag = '';
		this.getMetadata = getMetadata;

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

		await this.fetch();
		await this.getRemote();
		await this.selectAction();
	}

	async isClean() {
		const {files, ahead, behind} = await git.status();
		return files.length === 0 && ahead === 0 && behind === 0;
	}

	// read repo config
	async readConfig() {
		const filePath = path.resolve(process.cwd(), './package.json');
		const file = JSON.parse(fs.readFileSync(filePath));
		if (!file.houston) {
			return;
		}
		const { houston } = file;
		if (houston.updateFiles) {
			houston.updateFiles.forEach((file) => {
				files.push(file);
			});
		}

		if (houston.minTag) {
			this.minTag = houston.minTag;
		}
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

		// TODO: Allow select remote when more then one exists

		const [, owner, repo] = String(remotes[0]).match(/[\/:]([^\/]+)\/([^\/]+)\.git$/);
		this.owner = owner;
		this.repo = repo;
		console.log(`Working with repository ${ owner }/${ repo }`);
	}

	async fetch() {
		await git.fetch();
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
				name: 'Beta Release', value: 'beta-release'
			}, {
				name: 'Release Candidate', value: 'release-candidate'
			}, {
				name: 'Final Release', value: 'release'
			}, {
				name: 'Final Release From Cherry Picks', value: 'release-from-cherry-picks'
			}, {
				name: 'Develop Sync', value: 'develop-sync'
			}, {
				name: 'Create release issue', value: 'create-release-issue'
			}]
		}]);

		if (answer === 'release-candidate') {
			return await this.newReleaseCandidate();
		}

		if (answer === 'beta-release') {
			return await this.newBetaRelease();
		}

		if (answer === 'release') {
			return await this.newFinalRelease();
		}

		if (answer === 'release-from-cherry-picks') {
			return await this.newFinalReleaseFromCherryPicks();
		}

		if (answer === 'develop-sync') {
			return await this.newSyncRelease();
		}

		if (answer === 'create-release-issue') {
			return await this.createReleaseIssue();
		}

		throw new Error(`No release action for branch ${ status.current }`);
	}

	async createReleaseIssue() {
		await this.goToBranch({branch: 'develop', readVersion: true});
		await this.selectVersionToUpdate({currentVersion: this.version, release: 'patch'});
		await this.createReleaseIssueOnGitHub();
	}

	async newReleaseCandidate() {
		// TODO: Allow start from develop and ask for create the release-candidate branch
		await this.goToBranch({branch: 'release-candidate', readVersion: true});
		await this.shouldMergeFromTo({from: 'origin/develop', to: 'release-candidate'});
		await this.selectVersionToUpdate({currentVersion: this.version, release: 'prerelease', identifier: 'rc'});
		await this.updateVersionInFiles();
		await this.updateHistory();
		await this.shouldPushCurrentBranch();
		await this.shouldAddTag();
		await this.shouldSetHistoryToGithubRelease(true);
	}

	async newBetaRelease() {
		// TODO: Allow start from develop and ask for create the release-candidate branch
		await this.goToBranch({branch: 'beta-release', readVersion: true});
		await this.shouldMergeFromTo({from: 'origin/develop', to: 'beta-release'});
		await this.selectVersionToUpdate({currentVersion: this.version, release: 'prerelease', identifier: 'beta'});
		await this.updateVersionInFiles();
		await this.updateHistory();
		await this.shouldPushCurrentBranch();
		await this.shouldAddTag();
		await this.shouldSetHistoryToGithubRelease(true);
	}

	async newFinalRelease() {
		await this.goToBranch({branch: 'release-candidate', readVersion: true});
		await this.selectVersionToUpdate({currentVersion: this.version, release: 'patch'});
		await this.goToBranch({branch: 'master', pull: true});
		await this.createAndGoToBranch({branch: `release-${ this.version }`});
		await this.shouldMergeFromTo({from: 'origin/release-candidate', to: `release-${ this.version }`});
		await this.updateVersionInFiles();
		await this.updateHistory();
		await this.shouldPushCurrentBranch();
		await this.shouldCreateDraftReleaseWithHistory();
		await this.shouldCreateReleasePullRequest();
	}

	async newFinalReleaseFromCherryPicks() {
		await this.goToBranch({branch: 'master', pull: true, readVersion: true});
		await this.selectVersionToUpdate({currentVersion: this.version, release: 'patch'});
		await this.createAndGoToBranch({branch: `release-${ this.version }`});
		console.log('---\nExecute the cherry picks\n---');
		await this.shouldContinue();
		await this.updateVersionInFiles();
		await this.updateHistory();
		await this.shouldPushCurrentBranch();
		await this.shouldCreateDraftReleaseWithHistory();
		await this.shouldCreateReleasePullRequest();
	}

	async newSyncRelease() {
		await this.goToBranch({branch: 'master', pull: true, readVersion: true});
		await this.goToBranch({branch: 'develop', pull: true});
		await this.createAndGoToBranch({branch: 'develop-sync'});
		await this.shouldMergeFromTo({from: 'origin/master', to: 'develop-sync'});
		await this.selectVersionToUpdate({currentVersion: this.version, release: 'minor', suffix: '-develop'});
		await this.updateVersionInFiles();
		await this.shouldPushCurrentBranch();
		await this.shouldCreateDevelopSyncPullRequest();
	}

	async createReleaseIssueOnGitHub() {
		const filePath = '.github/ISSUE_TEMPLATE/release.md';
		let body = await readFile(filePath, 'utf8');
		body = body.replace(/\{version\}/g, this.version);
		body = body.replace(/---(.|\n)+?---\n/m, '');

		const { data: me } = await octokit.users.get({});

		console.log('Creating release issue');
		const issue = await octokit.issues.create({
			owner: this.owner,
			repo: this.repo,
			title: `Release ${ this.version }`,
			assignee: me.login,
			// milestone
			body
		});
		if (issue.data) {
			console.log(`Issue created: ${ issue.data.title }`);
			console.log(issue.data.html_url);
		}
	}

	async shouldPushTag() {
		const answers = await inquirer.prompt([{
			type: 'confirm',
			message: 'Push tag?',
			name: 'pushTag'
		}]);

		return answers.pushTag && await git.push(['-u', 'origin', this.version, ...PUSH_TAG_OPTIONS.split(' ').filter(i => i)]);
	}

	async shouldPushCurrentBranch() {
		const status = await git.status();

		const answers = await inquirer.prompt([{
			type: 'confirm',
			message: `Push ${ status.current } branch?`,
			name: 'pushBranch'
		}]);

		return answers.pushBranch && await git.push(['-u', 'origin', status.current, ...PUSH_CURRENT_BRANCH_OPTIONS.split(' ').filter(i => i)]);
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

	async checkoutBranch({branch, askToChange = true}) {
		const currentBranch = await this.currentBranch();
		if (currentBranch === branch) {
			return;
		}

		if (askToChange) {
			const { answer } = await inquirer.prompt([{
				type: 'list',
				message: `You\'re not on branch ${ branch }. Would you?`,
				name: 'answer',
				default: 'change',
				choices: [{
					name: `Change to ${ branch }`,
					value: 'change'
				}, {
					name: 'Continue from here',
					value: 'continue'
				}]
			}]);

			if (answer === 'continue') {
				return;
			}
		}

		console.log('Switching to branch', branch);

		const localBranch = await git.branchLocal();
		if (!localBranch.all.includes(branch)) {
			return git.checkoutLocalBranch(branch);
		}

		git.checkout(branch);
	}

	async goToBranch({branch, readVersion = false, pull = false, askToChange = true}) {
		await this.checkoutBranch({branch, askToChange});

		if (pull) {
			await this.pull();
		}

		if (readVersion) {
			this.readVersionFromPackageJson();
		}
	}

	async pull() {
		const answers = await inquirer.prompt([{
			type: 'confirm',
			message: 'Pull from origin?',
			name: 'pull'
		}]);

		if (!answers.pull) {
			return;
		}

		await git.pull();
	}

	async shouldContinue() {
		const answers = await inquirer.prompt([{
			type: 'confirm',
			message: 'Do you want to continue?',
			name: 'continue'
		}]);

		if (!answers.continue) {
			process.exit();
		}
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
				console.log('Creating branch', branch);
				await git.checkoutLocalBranch(branch);
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

		try {
			return answers.merge && await git.mergeFromTo(from, to);
		} catch (error) {
			console.log('Error while merging, please do it manually');
			console.error(error);
			return this.shouldContinue();
		}
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
		await this.readConfig();

		await Promise.all(files.map(async(file) => {
			let data = await readFile(`./${ file }`, 'utf8');
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
		await logs({headName: this.version, getMetadata: this.getMetadata, owner: this.owner, repo: this.repo, minTag: this.minTag });
		await md({ owner: this.owner, repo: this.repo });
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

	async shouldSetHistoryToGithubRelease(prerelease = false) {
		const answers = await inquirer.prompt([{
			type: 'confirm',
			message: 'Set history to tag?',
			name: 'pushTag'
		}]);

		const body = await md({tag: this.version, write: false, title: false, owner: this.owner, repo: this.repo});
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
					prerelease
				});
			} catch (error) {
				if (error.status === 404) {
					console.log('Creating release');
					await octokit.repos.createRelease({
						owner: this.owner,
						repo: this.repo,
						tag_name: this.version,
						name: this.version,
						body,
						draft: false,
						prerelease
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

		const body = await md({tag: this.version, write: false, title: false, owner: this.owner, repo: this.repo});
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

		const body = await md({tag: this.version, write: false, title: false, owner: this.owner, repo: this.repo});
		if (answers.create) {
			console.log('Creating pull request');
			const pr = await octokit.pulls.create({
				owner: this.owner,
				repo: this.repo,
				title: `Release ${ this.version }`,
				head: await this.currentBranch(),
				base: 'master',
				body
			});
			if (pr.data) {
				console.log(`Pull Request created: ${ pr.data.title }`);
				console.log(pr.data.html_url);
			}
		}
	}

	async shouldCreateDevelopSyncPullRequest() {
		const answers = await inquirer.prompt([{
			type: 'confirm',
			message: 'Create a GitHub Pull Request for develop sync?',
			name: 'create'
		}]);

		if (answers.create) {
			console.log('Creating pull request');
			const pr = await octokit.pulls.create({
				owner: this.owner,
				repo: this.repo,
				title: `Merge master into develop & Set version to ${ this.version }`,
				head: await this.currentBranch(),
				base: 'develop'
			});
			if (pr.data) {
				console.log(`Pull Request created: ${ pr.data.title }`);
				console.log(pr.data.html_url);
			}
		}
	}
}

module.exports = function({ owner, repo }, getMetadata) {
	const houston = new Houston({ owner, repo, getMetadata });
	houston.init().catch(error => console.error(error));
};

