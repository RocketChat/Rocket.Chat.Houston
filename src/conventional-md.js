const path = require('path');
const fs = require('fs');
const execSync = require('child_process').execSync;
const { Octokit } = require('@octokit/rest');

const Handlebars = require('handlebars');

const H = require('just-handlebars-helpers');

H.registerHelpers(Handlebars);

function loadHelpers(helpers) {
	Object.entries(helpers).forEach(([name, helper]) => {
		if (Handlebars.helpers[name]) {
			name = `_${ name }`;
		}
		Handlebars.registerHelper(name, helper);
	});
}

function loadTemplatesFromDir(dir) {
	fs.readdirSync(dir).forEach((file) => {
		if (file.endsWith('.hbs')) {
			let name = file.replace('.hbs', '');
			if (Handlebars.partials[name]) {
				name = `_${ name }`;
			}
			Handlebars.registerPartial(name, fs.readFileSync(path.join(dir, file)).toString());
		}

		if (file.endsWith('.js')) {
			const helpers = require(path.join(dir, file));
			if (typeof helpers === 'function') {
				loadHelpers({
					[file.replace('.js', '')]: helpers
				});
			} else if (typeof helpers === 'object') {
				loadHelpers(helpers);
			}
		}
	});
}

try {
	loadTemplatesFromDir(path.resolve(process.cwd(), '.houston/templates'));
} catch (e) {
	//
}

loadTemplatesFromDir(path.resolve(__dirname, '../templates'));

const template = Handlebars.compile('{{> changelog}}');

function getLatestCommitDate() {
	return execSync('git log --date=short --format=\'%ad\' -1').toString().replace(/\n/, '');
}

module.exports = async function({releases, title = true, owner, repo} = {}) {
	const octokit = new Octokit({
		auth: process.env.GITHUB_TOKEN
	});

	const data = await octokit.paginate(octokit.orgs.listMembers, {
		org: owner
	});
	const teamMembers = data.map(({ login }) => login);

	const lastCommitDate = getLatestCommitDate();

	const file = template({
		teamMembers,
		releases,
		owner,
		repo,
		showTitle: title,
		lastCommitDate
	});

	return file;
};
