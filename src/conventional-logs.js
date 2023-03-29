const path = require('path');
const fs = require('fs');
const semver = require('semver');
const ProgressBar = require('progress');
const _ = require('underscore');
const git = require('simple-git/promise')(process.cwd());
const { Octokit } = require('@octokit/rest');
const { getMetadata } = require('./utils');

const commitRegexString = '(^Merge pull request #([0-9]+) from )|( ?\\(?#([0-9]+)\\)?$)';
const commitRegex = new RegExp(commitRegexString);

const https = require('https');

function request(url) {
	return new Promise((resolve, reject) => {
		https.get(url, (res) => {

			const data = [];
			res.on('data', d => data.push(d));
			res.on('end', () => resolve(Buffer.concat(data).toString()));

		}).on('error', reject);
	});
}

const historyDataFile = path.join(process.cwd(), '.github/history.json');

let historyData = (() => {
	try {
		return require(historyDataFile);
	} catch (error) {
		console.error(`File ${ historyDataFile } not found, start a empty one`);
		return {
			version: 1,
			releases: {}
		};
	}
})();

if (!historyData.version) {
	historyData = {
		version: 1,
		releases: Object.entries(historyData).reduce((result, [release, pull_requests]) => {
			result[release] = {
				pull_requests
			};
			return result;
		}, {})
	};
}

const octokit = new Octokit({
	auth: process.env.GITHUB_TOKEN
});

let owner = '';
let repo = '';

function promiseRetryRateLimit(promiseFn, retryWait = 60000) {
	return new Promise((resolve, reject) => {
		function exec() {
			promiseFn()
				.then(data => resolve(data))
				.catch(error => {
					if (error.response.headers['status'] === '403 Forbidden' && error.response.headers['retry-after']) {
						const reset = error.response.headers['retry-after'];

						console.error('Retrying in', reset, 'seconds');
						console.log('Retrying in', reset, 'seconds');
						setTimeout(exec, reset * 1000);
					} else if (error.response.headers['x-ratelimit-remaining'] === '0') {
						let reset = error.response.headers['x-ratelimit-reset'];
						if (reset) {
							reset = parseInt(reset) * 1000 - Date.now();
						}

						console.log('Retrying in', (reset || retryWait) / 1000, 'seconds');
						setTimeout(exec, reset || retryWait);
					} else {
						return reject(error);
					}
				});
		}
		exec();
	});
}

function extractDescription(body) {
	const match = body.match(/<!-- CHANGELOG -->\r?\n?(?<description>.*)\r?\n?<!-- END CHANGELOG -->/s);
	if (!match || !match.groups || !match.groups.description) {
		return;
	}

	return match.groups.description.replace(/<!--.*?-->\r?\n?/gs, '').replace(/(\r?\n)*$/gs, '').trim();
}

function getPRInfo(number, commit) {
	function onError(error) {
		if (error.status === 404) {
			return;
		}
		console.error(commit, error);
		process.exit(1);
	}

	return promiseRetryRateLimit(() => octokit.pulls.get({owner, repo, pull_number: number}))
		.catch(onError)
		.then(pr => {
			if (pr === undefined) {
				return;
			}

			const info = {
				pr: number,
				title: pr.data.title,
				userLogin: pr.data.user.login
			};

			if (typeof pr.data.body === 'string') {
				const description = extractDescription(pr.data.body);
				if (description) {
					info.description = description;
				}
			}
			// data.author_association: 'CONTRIBUTOR',

			if (pr.data.milestone) {
				info.milestone = pr.data.milestone.title;
			}

			return promiseRetryRateLimit(() => octokit.pulls.listCommits({owner, repo, pull_number: number}))
				.catch(onError)
				.then(commits => {
					info.contributors = _.unique(_.flatten(commits.data.map(i => {
						if (!i.author || !i.committer) {
							return;
						}

						return [i.author.login, i.committer.login];
					})));

					return info;
				});
		});
}

function getPRNumberFromMessage(message, item) {
	const match = message.match(commitRegex);
	if (match == null) {
		console.log(message, item);
	}
	const number = match[2] || match[4];

	if (!/^\d+$/.test(number)) {
		console.error('Invalid number', {number, message});
		process.exit(1);
	}

	return number;
}

function getCommitRange(from, to) {
	if (!from && !to) {
		console.error('Invalid commits for range');
		process.exit(1);
	}

	if (from && to) {
		return `${ from }...${ to }`;
	}

	if (!from) {
		return `${ to }^@`;
	}

	return `${ from }...HEAD`;
}

async function getPullRequests(from, to) {
	const logParams = ['--no-decorate', '--graph', '-E', `--grep=${ commitRegexString }`, getCommitRange(from, to)];
	logParams.format = {
		hash: '%H',
		date: '%ai',
		message: '%s',
		author_name: '%aN',
		author_email: '%ae'
	};

	const log = await git.log(logParams);

	const items = log.all
		.filter(item => commitRegex.test(item.message));

	const data = [];

	return new Promise((resolve, reject) => {
		const bar = new ProgressBar('  [:bar] :current/:total :percent :etas', {
			total: items.length,
			incomplete: ' ',
			width: 20
		});

		function process() {
			if (items.length === 0) {
				resolve(data);
			}

			const partItems = items.splice(0, 10);
			bar.tick(partItems.length);

			const promises = partItems.map(item => {
				return getPRInfo(getPRNumberFromMessage(item.message, item), item);
			});

			return Promise.all(promises).then(result => {
				data.push(..._.compact(result));
				if (items.length) {
					setTimeout(process, 100);
				} else {
					resolve(data);
				}
			}).catch(error => reject(error));
		}

		process();
	});
}

module.exports = async function({ oldVersion, version, owner:_owner = '', repo:_repo = '', getMetadata }) {
	owner = _owner;
	repo = _repo;

	const prs = await getPullRequests(oldVersion, 'HEAD');

	const metadata = await getMetadata({ version: 'HEAD', git, request });

	return {
		prs,
		metadata,
	};
};
