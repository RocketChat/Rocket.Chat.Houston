const inquirer = require('inquirer');
const git = require('simple-git/promise')(process.cwd());
const Octokit = require('@octokit/rest');

const octokit = new Octokit();

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

module.exports = async function({owner = '', repo = '', prNumber, finish}) {
	if (!prNumber || isNaN(parseInt(prNumber))) {
		console.error('PR number is required');
		process.exit(1);
	}

	const pr = await octokit.pulls.get({owner, repo, number: prNumber});

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
