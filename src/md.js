const path = require('path');
const fs = require('fs');
const semver = require('semver');
const _ = require('underscore');
const execSync = require('child_process').execSync;
const octokit = require('@octokit/rest')();

const historyDataFile = path.join(process.cwd(), '.github/history.json');
const historyManualDataFile = path.join(process.cwd(), '.github/history-manual.json');
const historyFile = path.join(process.cwd(), 'HISTORY.md');

octokit.authenticate({
	type: 'token',
	token: process.env.GITHUB_TOKEN
});

const systemUsers = ['web-flow'];
let nonContributors = [];

const GroupNames = {
	IMPROVE: '### 🚀 Improvements',
	FIX: '### 🐛 Bug fixes',
	NEW: '### 🎉 New features',
	BREAK: '### ⚠️ BREAKING CHANGES',
	MINOR: '🔍 Minor changes'
};

const SummaryNameEmoticons = {
	IMPROVE: '🚀',
	FIX: '🐛',
	NEW: '🎉',
	BREAK: '️️️⚠️',
	NOGROUP: '🔍',
	contributor: '👩‍💻👨‍💻'
};

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

	return groups;
}

function getTagDate(tag) {
	return execSync(`git tag -l --format="%(creatordate:short)" ${ tag }`).toString().replace(/\n/, '');
}

function getLatestCommitDate() {
	return execSync('git log --date=short --format=\'%ad\' -1').toString().replace(/\n/, '');
}

function getSummary(contributors, teamContributors, groupedPRs) {
	const summary = [];

	Object.keys(groupedPRs).forEach(group => {
		if (groupedPRs[group].length) {
			summary.push(`${ groupedPRs[group].length } ${ SummaryNameEmoticons[group] }`);
		}
	});

	if (contributors.length + teamContributors.length) {
		summary.push(`${ contributors.length + teamContributors.length } ${ SummaryNameEmoticons.contributor }`);
	}

	if (summary.length) {
		return `  ·  ${ summary.join('  ·  ') }`;
	}

	return '';
}

function renderPRs(prs, historyDataReleasesOriginal, tag) {
	const otherTags = Object.keys(historyDataReleasesOriginal).filter(k => {
		if (tag === 'HEAD') {
			return true;
		}
		return k !== 'HEAD' && semver.lt(k, tag);
	});

	const olderReleases = otherTags.map(t => historyDataReleasesOriginal[t]);
	prs = prs.filter(p => !olderReleases.some(r => r.pull_requests.some(p2 => p2.pr === p.pr)));

	const data = [];
	const groupedPRs = groupPRs(prs);

	Object.keys(groupedPRs).forEach(group => {
		const prs = groupedPRs[group];
		if (!prs.length) {
			return;
		}

		const groupName = GroupNames[group];

		if (group === 'NOGROUP') {
			data.push(`\n<details>\n<summary>${ GroupNames.MINOR }</summary>\n`);
		} else {
			data.push(`\n${ groupName }\n`);
		}
		prs.forEach(pr => {
			let contributors = _.compact(_.difference(pr.contributors, nonContributors, systemUsers))
				.sort()
				.map(contributor => `[@${ contributor }](https://github.com/${ contributor })`)
				.join(' & ');

			if (contributors) {
				contributors = ` by ${ contributors }`;
			}

			const prInfo = pr.pr ? ` ([#${ pr.pr }](https://github.com/RocketChat/Rocket.Chat/pull/${ pr.pr })${ contributors })` : '';
			data.push(`- ${ pr.title }${ prInfo }`);
		});
		if (group === 'NOGROUP') {
			data.push('\n</details>');
		}
	});

	const contributors = _.compact(_.difference(prs.reduce((value, pr) => {
		return _._.unique(value.concat(pr.contributors));
	}, []), nonContributors, systemUsers));

	const teamContributors = _.compact(_.intersection(prs.reduce((value, pr) => {
		return _.unique(value.concat(pr.contributors));
	}, []), nonContributors));

	if (contributors.length) {
		// TODO: Improve list like https://gist.github.com/paulmillr/2657075/
		data.push('\n### 👩‍💻👨‍💻 Contributors 😍\n');
		contributors.sort().forEach(contributor => {
			data.push(`- [@${ contributor }](https://github.com/${ contributor })`);
		});
	}

	if (teamContributors.length) {
		// TODO: Improve list like https://gist.github.com/paulmillr/2657075/
		data.push('\n### 👩‍💻👨‍💻 Core Team 🤓\n');
		teamContributors.sort().forEach(contributor => {
			data.push(`- [@${ contributor }](https://github.com/${ contributor })`);
		});
	}

	return {
		data,
		summary: getSummary(contributors, teamContributors, groupedPRs)
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

module.exports = async function({tag, write = true, title = true} = {}) {
	// TODO: Get org from repo
	const membersResult = await octokit.orgs.getMembers({org: 'RocketChat', per_page: 100});
	nonContributors = membersResult.data.map(i => i.login);
	if (nonContributors.length === 100) {
		console.log('Need to implement pagination for members list');
	}

	let historyDataReleases = (() => {
		try {
			return JSON.parse(fs.readFileSync(historyDataFile).toString()).releases;
		} catch (error) {
			throw new Error(`File ${ historyDataFile } not found`);
		}
	})();

	const historyDataReleasesOriginal = historyDataReleases;

	let historyManualData = (() => {
		try {
			return JSON.parse(fs.readFileSync(historyManualDataFile).toString());
		} catch (error) {
			console.error(`File ${ historyManualDataFile } not found, ignoring manual entries`);
			return {};
		}
	})();

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
		historyDataReleases[tag].pull_requests.unshift(...historyManualData[tag]);
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

	const file = [];

	Object.keys(historyDataReleases).sort(sort).forEach(tag => {
		const {pull_requests, rcs, node_version, npm_version} = historyDataReleases[tag];

		if (!pull_requests.length && !rcs.length) {
			return;
		}

		const tagDate = tag === 'HEAD' ? getLatestCommitDate() : (getTagDate(tag) || getLatestCommitDate());

		const {data, summary} = renderPRs(pull_requests, historyDataReleasesOriginal, tag);

		const tagText = tag === 'HEAD' ? 'Next' : tag;

		if (historyDataReleases[tag].noMainRelease) {
			if (title) {
				file.push(`\n# ${ tagText } (Under Release Candidate Process)`);
			}
		} else {
			if (title) {
				file.push(`\n# ${ tagText }`);
			}
			file.push(`\`${ tagDate }${ summary }\``);

			if (node_version || npm_version) {
				file.push('\n### Engine versions');
				if (node_version) {
					file.push(`- Node: \`${ node_version }\``);
				}
				if (npm_version) {
					file.push(`- NPM: \`${ npm_version }\``);
				}
			}
		}

		file.push(...data);

		if (Array.isArray(rcs)) {
			rcs.reverse().forEach(rc => {
				const {data, summary} = renderPRs(rc.pull_requests, historyDataReleasesOriginal, rc.tag);

				if (historyDataReleases[tag].noMainRelease) {
					const tagDate = getTagDate(rc.tag) || getLatestCommitDate();
					if (title) {
						file.push(`\n## ${ rc.tag }`);
					}
					file.push(`\`${ tagDate }${ summary }\``);

					if (node_version || npm_version) {
						file.push('\n### Engine versions');
						if (node_version) {
							file.push(`- Node: \`${ node_version }\``);
						}
						if (npm_version) {
							file.push(`- NPM: \`${ npm_version }\``);
						}
					}
				}

				file.push(...data);
			});
		}
	});

	write && fs.writeFileSync(historyFile, file.join('\n'));

	return file.join('\n');
};
