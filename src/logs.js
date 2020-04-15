const path = require('path');
const fs = require('fs');
const semver = require('semver');
const ProgressBar = require('progress');
const _ = require('underscore');
const git = require('simple-git/promise')(process.cwd());
const octokit = require('@octokit/rest')();

const commitRegexString = '(^Merge pull request #([0-9]+) from )|( \\(#([0-9]+)\\)$)';
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

octokit.authenticate({
	type: 'token',
	token: process.env.GITHUB_TOKEN
});
let owner = '';
let repo = '';

function promiseRetryRateLimit(promiseFn, retryWait = 60000) {
	return new Promise((resolve, reject) => {
		function exec() {
			promiseFn()
				.then(data => resolve(data))
				.catch(error => {
					if (error.headers['status'] === '403 Forbidden' && error.headers['retry-after']) {
						const reset = error.headers['retry-after'];

						console.error('Retrying in', reset, 'seconds');
						console.log('Retrying in', reset, 'seconds');
						setTimeout(exec, reset * 1000);
					} else if (error.headers['x-ratelimit-remaining'] === '0') {
						let reset = error.headers['x-ratelimit-reset'];
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
		if (error.code === 404) {
			return;
		}
		console.error(commit, error);
		process.exit(1);
	}

	return promiseRetryRateLimit(() => octokit.pullRequests.get({owner, repo, number}))
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

			return promiseRetryRateLimit(() => octokit.pullRequests.listCommits({owner, repo, number}))
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

async function getPullRequests(from, to) {
	const logParams = ['--no-decorate', '--graph', '-E', `--grep=${ commitRegexString }`, `${ from }...${ to }`];
	logParams.format = {
		hash: '%H',
		date: '%ai',
		message: '%s',
		author_name: '%aN',
		author_email: '%ae'
	};

	const log = await git.log(logParams);

	const items = log.all
		.filter(item => /^(\*\s)[0-9a-z]+$/.test(item.hash))
		.map(item => {
			item.hash = item.hash.replace(/^(\*\s)/, '');
			return item;
		})
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

async function getCurrentLatestTag() {
	return (await git.raw(['describe', '--abbrev=0', '--tags'])).replace(/\n/, '');
}

async function getTags({ minTag }) {
	let tags = await git.tags();

	tags = tags.all.filter(tag => /^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(tag));

	tags = tags.sort((a, b) => {
		if (semver.gt(a, b)) {
			return 1;
		}
		if (semver.lt(a, b)) {
			return -1;
		}
		return 0;
	});

	const currentLatestTag = await getCurrentLatestTag();
	tags = tags.filter(t => semver.lte(t, currentLatestTag));

	tags.push('HEAD');

	return tags
		.map((item, index) => {
			return {
				tag: item,
				before: index ? tags[--index] : null
			};
		})
		.filter(item => item.tag === 'HEAD' || (minTag && semver.gte(item.tag, minTag)))
		.reduce((value, item) => {
			value[item.tag] = item;
			return value;
		}, {});
}

async function getMissingTags({ minTag }) {
	const tags = await getTags({ minTag });
	const missingTags = _.difference(Object.keys(tags), Object.keys(historyData.releases));

	missingTags.push('HEAD');

	return _.pick(tags, missingTags);
}

module.exports = function({headName = 'HEAD', owner:_owner = '', repo:_repo = '', minTag = '', getMetadata = () => Promise.resolve({}) }) {
	owner = _owner;
	repo = _repo;

	return new Promise((resolve) => {
		getMissingTags({ minTag }).then(missingTags => {
			console.log('Missing tags:');
			console.log(JSON.stringify(Object.keys(missingTags), null, 2));
			missingTags = Object.values(missingTags);

			function loadMissingTag() {
				if (!missingTags.length) {
					if (headName !== 'HEAD') {
						historyData.releases[headName] = historyData.releases.HEAD;
						historyData.releases.HEAD = {
							pull_requests: []
						};
					}
					fs.writeFileSync(historyDataFile, JSON.stringify(historyData, null, 2));
					resolve();
					return;
				}

				const item = missingTags.shift();
				const from = item.before;
				const to = item.tag;
				console.log('Fetching data for tag:', to, `(from ${ from })`);
				getPullRequests(from, to).then(pull_requests => {
					getMetadata({ version: to, git, request }).then(metadata => {
						pull_requests = _.compact(pull_requests);
						// console.log('  ', pull_requests.length, 'item(s) found');
						historyData.releases = Object.assign(historyData.releases, {
							[to]: {
								...metadata,
								pull_requests
							}
						});
						fs.writeFileSync(historyDataFile, JSON.stringify(historyData, null, 2));
						loadMissingTag();
					});
				});
			}

			loadMissingTag();
		});
	});
};
