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
	FIX: '### 🐛 Bug fixes',
	NEW: '### 🎉 New features',
	BREAK: '### ⚠️ BREAKING CHANGES',
	MINOR: '🔍 Minor changes'
};

const SummaryNameEmoticons = {
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
		FIX: [],
		NOGROUP: []
	};

	prs.forEach(pr => {
		const match = pr.title.match(/\[(FIX|NEW|BREAK)\]\s*(.+)/);
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

function renderPRs(prs) {
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

	let historyData = (() => {
		try {
			return JSON.parse(fs.readFileSync(historyDataFile).toString());
		} catch (error) {
			throw new Error(`File ${ historyDataFile } not found`);
		}
	})();

	let historyManualData = (() => {
		try {
			return JSON.parse(fs.readFileSync(historyManualDataFile).toString());
		} catch (error) {
			console.error(`File ${ historyManualDataFile } not found, ignoring manual entries`);
			return {};
		}
	})();

	if (tag) {
		historyData = Object.entries(historyData).filter(([key]) => key.indexOf(tag) === 0).reduce((v, [key, value]) => {
			v[key] = value;
			return v;
		}, {});
		historyManualData = Object.entries(historyManualData).filter(([key]) => key.indexOf(tag) === 0).reduce((v, [key, value]) => {
			v[key] = value;
			return v;
		}, {});
		historyData[tag] = historyData[tag] || [];
		historyManualData[tag] = historyManualData[tag] || [];
	}

	Object.keys(historyManualData).forEach(tag => {
		historyData[tag] = historyData[tag] || [];
		historyData[tag].unshift(...historyManualData[tag]);
	});

	Object.keys(historyData).forEach(tag => {
		historyData[tag] = {
			prs: historyData[tag],
			rcs: []
		};
	});

	Object.keys(historyData).forEach(tag => {
		if (/-rc/.test(tag)) {
			const mainTag = tag.replace(/-rc.*/, '');
			historyData[mainTag] = historyData[mainTag] || {
				noMainRelease: true,
				prs: [],
				rcs: []
			};

			if (historyData[mainTag].noMainRelease) {
				historyData[mainTag].rcs.push({
					tag,
					prs: historyData[tag].prs
				});
			} else {
				historyData[mainTag].prs.push(...historyData[tag].prs);
			}

			delete historyData[tag];
		}
	});

	const file = [];

	Object.keys(historyData).sort(sort).forEach(tag => {
		const {prs, rcs} = historyData[tag];

		if (!prs.length && !rcs.length) {
			return;
		}

		const tagDate = tag === 'HEAD' ? getLatestCommitDate() : (getTagDate(tag) || getLatestCommitDate());

		const {data, summary} = renderPRs(prs);

		const tagText = tag === 'HEAD' ? 'Next' : tag;

		if (historyData[tag].noMainRelease) {
			if (title) {
				file.push(`\n# ${ tagText } (Under Release Candidate Process)`);
			}
		} else {
			if (title) {
				file.push(`\n# ${ tagText }`);
			}
			file.push(`\`${ tagDate }${ summary }\``);
		}

		file.push(...data);

		if (Array.isArray(rcs)) {
			rcs.reverse().forEach(rc => {
				const {data, summary} = renderPRs(rc.prs);

				if (historyData[tag].noMainRelease) {
					const tagDate = getTagDate(rc.tag) || getLatestCommitDate();
					if (title) {
						file.push(`\n## ${ rc.tag }`);
					}
					file.push(`\`${ tagDate }${ summary }\``);
				}

				file.push(...data);
			});
		}
	});

	write && fs.writeFileSync(historyFile, file.join('\n'));

	return file.join('\n');
};
