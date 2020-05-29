const inquirer = require('inquirer');
const git = require('simple-git/promise')(process.cwd());
const { Octokit } = require('@octokit/rest');

const octokit = new Octokit({
	auth: process.env.GITHUB_TOKEN
});

async function hasRemote(name) {
	const remotes = await git.getRemotes();

	return remotes.find((r) => r.name === name);
}

async function checkoutBranch(branch) {
	const localBranch = await git.branchLocal();
	if (!localBranch.all.includes(branch)) {
		return await git.checkoutLocalBranch(branch);
	}

	await git.checkout(branch);
}

module.exports.checkout = async function({owner = '', repo = '', prNumber, finish}) {
	if (!prNumber || isNaN(parseInt(prNumber))) {
		console.error('PR number is required');
		process.exit(1);
	}

	const pr = await octokit.pulls.get({owner, repo, pull_number: prNumber});

	const ssh_url = pr.data.head.repo.ssh_url;
	const ref = pr.data.head.ref;
	const login = pr.data.user.login;

	const answers = await inquirer.prompt([{
		type: 'confirm',
		message: `Continue with PR #${ prNumber } ${ pr.data.title } from ${ login }/${ ref }?`,
		name: 'continue'
	}]);

	if (!answers.continue) {
		return;
	}

	const branchName = `pr/${ prNumber }`;

	if (finish) {
		if (await hasRemote(login)) {
			await git.removeRemote(login);
		}
		await checkoutBranch('develop');
		await git.deleteLocalBranch(branchName, true);
		return;
	}

	if (!await hasRemote(login)) {
		await git.addRemote(login, ssh_url);
	}

	await git.fetch(login, ref);

	if ((await git.branch()).all.includes(branchName)) {
		console.log(1);
		await checkoutBranch(branchName);
		await git.pull();
		return;
	}

	await git.checkoutBranch(branchName, `${ login }/${ ref }`);
};

const conflictLabel = 'stat: conflict';

async function checkDirtyForPR({owner = '', repo = '', pull_number}) {
	const pr = await octokit.pulls.get({owner, repo, pull_number});

	const hasLabel = pr.data.labels.find((label) => label.name === conflictLabel);
	// console.log(pr.data.mergeable_state, {hasLabel: !!hasLabel});

	if (pr.data.mergeable_state === 'dirty' && !hasLabel) {
		console.log('Adding label to PR', pull_number, pr.data.title);
		return await octokit.issues.addLabels({owner, repo, issue_number: pull_number, labels: [conflictLabel]});
	}

	if (pr.data.mergeable_state !== 'dirty' && hasLabel) {
		console.log('Removing label to PR', pull_number, pr.data.title);
		return await octokit.issues.removeLabel({owner, repo, issue_number: pull_number, name: conflictLabel});
	}
}

module.exports.checkDirty = async function({owner = '', repo = '', prNumber}) {

	try {
		if (!isNaN(parseInt(prNumber))) {
			return await checkDirtyForPR({owner, repo, pull_number: prNumber});
		}

		for await (const response of octokit.paginate.iterator(
			octokit.pulls.list,
			{owner, repo, state: 'open'}
		)) {
			for await (const pr of response.data) {
				await checkDirtyForPR({owner, repo, pull_number: pr.number});
			}
		}
	} catch (e) {
		console.error(e);
	}
};
