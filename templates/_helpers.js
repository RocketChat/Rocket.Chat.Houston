const _ = require('underscore');

const systemUsers = ['web-flow'];

const SummaryNameEmoticons = {
	IMPROVE: '🚀',
	FIX: '🐛',
	NEW: '🎉',
	BREAK: '️️️⚠️',
	NOGROUP: '🔍',
	contributor: '👩‍💻👨‍💻'
};

const GroupNames = {
	IMPROVE: '### 🚀 Improvements',
	FIX: '### 🐛 Bug fixes',
	NEW: '### 🎉 New features',
	BREAK: '### ⚠️ BREAKING CHANGES',
	MINOR: '🔍 Minor changes',
	NOGROUP: '🔍 Minor changes'
};

module.exports = {
	let(name, value, {data}) {
		data.root[name] = value;
	},

	groupedPRs(prs) {
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
	},

	groupTitle(group) {
		return GroupNames[group];
	},

	getPRContributors(pr, {data}) {
		const contributors = _.compact(_.difference(pr.contributors, data.root.teamMembers, systemUsers))
			.sort()
			.map(contributor => `[@${ contributor }](https://github.com/${ contributor })`)
			.join(' & ');

		if (contributors) {
			return ` by ${ contributors }`;
		}
	},

	prUrl(pr, {data}) {
		return `https://github.com/${ data.root.owner }/${ data.root.repo }/pull/${ pr }`;
	},

	description(pr) {
		return pr.description.replace(/(?=([*-]\s|\d+\.\s))/gm, '  ').replace(/^(?=[^\s])/gm, '  ');
	},

	summary({groupedPRs, externalContributors, teamContributors}) {
		const summary = [];

		groupedPRs.forEach(({key, values}) => {
			if (values.length) {
				summary.push(`${ values.length } ${ SummaryNameEmoticons[key] }`);
			}
		});

		if (externalContributors.length + teamContributors.length) {
			summary.push(`${ externalContributors.length + teamContributors.length } ${ SummaryNameEmoticons.contributor }`);
		}

		if (summary.length) {
			return summary.join('  ·  ');
		}
	},

	getExternalContributors(prs, {data}) {
		return _.compact(_.difference(prs.reduce((value, pr) => {
			return _.unique(value.concat(pr.contributors));
		}, []), data.root.teamMembers, systemUsers)).sort();
	},

	getTeamContributors(prs, {data}) {
		return _.compact(_.intersection(prs.reduce((value, pr) => {
			return _.unique(value.concat(pr.contributors));
		}, []), data.root.teamMembers)).sort();
	}
};
