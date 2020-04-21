const _ = require('underscore');

const systemUsers = ['web-flow'];

module.exports = {
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
	}
};
