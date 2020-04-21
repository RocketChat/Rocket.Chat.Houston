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
	groupTitle(group) {
		return GroupNames[group];
	},
	getPRContributors(pr, {data}) {
		const contributors = _.compact(_.difference(pr.contributors, data.root.nonContributors, systemUsers))
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

	summary({groupedPRs, contributors, teamContributors}) {
		const summary = [];

		groupedPRs.forEach(({key, values}) => {
			if (values.length) {
				summary.push(`${ values.length } ${ SummaryNameEmoticons[key] }`);
			}
		});

		if (contributors.length + teamContributors.length) {
			summary.push(`${ contributors.length + teamContributors.length } ${ SummaryNameEmoticons.contributor }`);
		}

		if (summary.length) {
			return summary.join('  ·  ');
		}
	}
};
