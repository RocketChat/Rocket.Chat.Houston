const { Octokit } = require('@octokit/rest');
const semver = require('semver');

const octokit = new Octokit({
	auth: process.env.GITHUB_TOKEN
});

module.exports = async function({owner, repo} = {}) {
	const releasesResult = await octokit.paginate(octokit.repos.listReleases.endpoint.merge({owner, repo, per_page: 100}));

	const releases = releasesResult.filter((release) => !release.tag_name.includes('-rc') && semver.gte(release.tag_name, '1.0.0')).sort((a, b) => semver.compare(b.tag_name, a.tag_name));

	const releasesMap = {};

	for (const release of releases) {
		releasesMap[release.tag_name] = release;
	}

	let index = 0;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const release = releases[index];
		if (!releases[index + 1]) {
			break;
		}

		const currentVersion = semver.parse(release.tag_name);
		const nextVersion = semver.parse(releases[index + 1].tag_name);

		if (currentVersion.major === nextVersion.major && currentVersion.minor === nextVersion.minor) {
			releases.splice(index + 1, 1);
			continue;
		}

		if (currentVersion.major !== nextVersion.major) {
			releases[index + 1].lts = true;
		}

		index++;
	}

	releases[0].last = true;
	for (const {tag_name, html_url, lts, last} of releases.reverse()) {
		const minor = tag_name.replace(/\.\d+$/, '');
		const releaseDate = new Date(releasesMap[`${ minor }.0`].published_at);
		if (releaseDate.getDate() < 20) {
			releaseDate.setMonth(releaseDate.getMonth() - 1);
		}
		const supportDate = new Date(releaseDate);
		supportDate.setMonth(supportDate.getMonth() + (lts ? 6 : 3));

		const release = `${ lts ? '**' : '' }${ minor }${ lts ? ' \\(LTS\\)**' : '' }`;
		const url = `[${ tag_name }](${ html_url })`;
		const releasedAt = `${ lts ? '**' : '' }${ releaseDate.toLocaleString('en', { month: 'short' }) } ${ releaseDate.getFullYear() }${ lts ? '**' : '' }`;
		const endOfLife = last ? 'TBD' : `${ lts ? '**' : '' }${ supportDate.toLocaleString('en', { month: 'short' }) } ${ supportDate.getFullYear() }${ lts ? '**' : '' }`;

		console.log(`| ${ release } | ${ url } | ${ releasedAt } | ${ endOfLife } |`);
		releaseDate.setMonth(releaseDate.getMonth() + 1);
	}
};
