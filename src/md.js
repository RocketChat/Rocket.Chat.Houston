const path = require('path');
const fs = require('fs');
const semver = require('semver');
const _ = require('underscore');
const execSync = require('child_process').execSync;
const octokit = require('@octokit/rest')();

const Handlebars = require('handlebars');

const H = require('just-handlebars-helpers');

H.registerHelpers(Handlebars);

function loadTemplatesFromDir(dir) {
	fs.readdirSync(dir).forEach((file) => {
		if (file.endsWith('.hbs')) {
			Handlebars.registerPartial(file.replace('.hbs', ''), fs.readFileSync(path.join(dir, file)).toString());
		}

		if (file.endsWith('.js')) {
			const helper = require(path.join(dir, file));
			if (typeof helper === 'function') {
				Handlebars.registerHelper(file.replace('.js', ''), helper);
			} else {
				Handlebars.registerHelper(helper);
			}
		}
	});
}

loadTemplatesFromDir(path.resolve(__dirname, '../templates'));
try {
	loadTemplatesFromDir(path.resolve(process.cwd(), '.houston'));
} catch (e) {
	//
}


const template = Handlebars.compile('{{> changelog}}');

const historyDataFile = path.join(process.cwd(), '.github/history.json');
const historyManualDataFile = path.join(process.cwd(), '.github/history-manual.json');
const historyFile = path.join(process.cwd(), 'HISTORY.md');

octokit.authenticate({
	type: 'token',
	token: process.env.GITHUB_TOKEN
});

const systemUsers = ['web-flow'];
let nonContributors = [];

function groupPRs(prs) {
	const groups = {
		BREAK: [],
		NEW: [],
		IMPROVE: [],
		FIX: [],
		NOGROUP: []
	};

	prs.forEach(pr => {
		const match = pr.title.match(/\[(FIX|IMPROVE|NEW|BREAK)\]\s*(.+)/);
		if (match) {
			pr.title = match[2];
			groups[match[1]].push(pr);
		} else {
			groups.NOGROUP.push(pr);
		}
	});

	return Object.entries(groups).map(([key, values]) => ({key, values}));
}

function getTagDate(tag) {
	return execSync(`git tag -l --format="%(creatordate:short)" ${ tag }`).toString().replace(/\n/, '');
}

function getLatestCommitDate() {
	return execSync('git log --date=short --format=\'%ad\' -1').toString().replace(/\n/, '');
}

function renderPRs(prs, owner, repo, release, tag, tagDate, releaseCandidate) {
	// remove duplicated PR entries
	prs = prs.filter((pr1, index1) => pr1.manual || !prs.some((pr2, index2) => pr1.pr === pr2.pr && index1 !== index2));

	const groupedPRs = groupPRs(prs);

	const contributors = _.compact(_.difference(prs.reduce((value, pr) => {
		return _.unique(value.concat(pr.contributors));
	}, []), nonContributors, systemUsers)).sort();

	const teamContributors = _.compact(_.intersection(prs.reduce((value, pr) => {
		return _.unique(value.concat(pr.contributors));
	}, []), nonContributors)).sort();

	return {
		data: template({
			nonContributors,
			release,
			groupedPRs,
			contributors,
			teamContributors,
			owner,
			repo,
			tag,
			tagDate,
			releaseCandidate
		}).replace(/\n$/, '')
	};
}

function sort(a, b) {
	if (a === 'HEAD') {
		return -1;
	}
	if (b === 'HEAD') {
		return 1;
	}

	if (semver.gt(a, b)) {
		return -1;
	}
	if (semver.lt(a, b)) {
		return 1;
	}
	return 0;
}

const renderVersion = (releases) => {
	if (!releases) {
		return '';
	}
	return releases.map((release) => release.body);
};

const getVersionObj = (release, tag, title, owner, repo, releaseCandidate = false) => {
	const { pull_requests, rcs } = release;

	const tagDate = tag === 'HEAD' ? getLatestCommitDate() : (getTagDate(tag) || getLatestCommitDate());

	const { data } = renderPRs(pull_requests, owner, repo, release, tag, tagDate, releaseCandidate);

	const version = {
		body: data
	};

	if (rcs) {
		version.body += rcs.reverse().map((rc) => renderVersion([getVersionObj(rc, rc.tag, title, owner, repo, true)])).join('\n');
	}

	return version;
};

const readHistoryFile = () => {
	try {
		return JSON.parse(fs.readFileSync(historyDataFile).toString()).releases;
	} catch (error) {
		throw new Error(`File ${ historyDataFile } not found`);
	}
};

const readManualFile = () => {
	try {
		return JSON.parse(fs.readFileSync(historyManualDataFile).toString());
	} catch (error) {
		console.error(`File ${ historyManualDataFile } not found, ignoring manual entries`);
		return {};
	}
};

module.exports = async function({tag, write = true, title = true, customMarkdown = (md) => Promise.resolve(md), owner, repo} = {}) {
	const membersResult = await octokit.orgs.listMembers({org: owner, per_page: 100});
	nonContributors = membersResult.data.map(i => i.login);
	if (nonContributors.length === 100) {
		console.log('Need to implement pagination for members list');
	}

	let historyDataReleases = readHistoryFile();

	let historyManualData = readManualFile();

	if (tag) {
		historyDataReleases = Object.entries(historyDataReleases).filter(([key]) => key.indexOf(tag) === 0).reduce((v, [key, value]) => {
			v[key] = value;
			return v;
		}, {});
		historyManualData = Object.entries(historyManualData).filter(([key]) => key.indexOf(tag) === 0).reduce((v, [key, value]) => {
			v[key] = value;
			return v;
		}, {});
		historyDataReleases[tag] = historyDataReleases[tag] || {
			pull_requests: []
		};
		historyManualData[tag] = historyManualData[tag] || [];
	}

	Object.keys(historyManualData).forEach(tag => {
		historyDataReleases[tag] = historyDataReleases[tag] || {
			pull_requests: []
		};
		historyDataReleases[tag].pull_requests.unshift(...historyManualData[tag].map((pr) => ({ manual: true, ...pr })));
	});

	Object.values(historyDataReleases).forEach(value => {
		value.rcs = [];
	});

	Object.keys(historyDataReleases).forEach(tag => {
		if (/-rc/.test(tag)) {
			const mainTag = tag.replace(/-rc.*/, '');
			historyDataReleases[mainTag] = historyDataReleases[mainTag] || {
				noMainRelease: true,
				pull_requests: [],
				rcs: []
			};

			if (historyDataReleases[mainTag].noMainRelease) {
				historyDataReleases[mainTag].rcs.push({
					tag,
					pull_requests: historyDataReleases[tag].pull_requests
				});
			} else {
				historyDataReleases[mainTag].pull_requests.push(...historyDataReleases[tag].pull_requests);
			}

			delete historyDataReleases[tag];
		}
	});

	const releases = await Promise.all(Object.keys(historyDataReleases)
		.sort(sort)
		.filter((tag) => {
			const { pull_requests, rcs } = historyDataReleases[tag];
			return pull_requests.length || rcs.length;
		})
		.map((tag) => customMarkdown(getVersionObj(historyDataReleases[tag], tag, title, owner, repo), historyDataReleases[tag])));

	const file = renderVersion(releases);

	write && fs.writeFileSync(historyFile, file.join('\n'));

	return file.join('\n');
};
