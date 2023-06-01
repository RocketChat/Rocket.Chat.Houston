import { simpleGit } from 'simple-git';
import fs from 'fs/promises';
import path from 'path';
import semver from 'semver';
import { outputCI } from '../outputCI';

const git = simpleGit();

export async function createBranch({ base, type }: { base: string; type: 'patch' | 'minor' | 'major' }) {
	// checkout base version
	await git.checkout(base);

	// get current version and increment based on type
	const mainPackageJson = await fs.readFile(path.resolve(process.cwd(), 'package.json'), 'utf8');
	const { version: currentVersion } = JSON.parse(mainPackageJson);

	const newBranch = `release-${semver.inc(currentVersion, type)}`;

	const localBranch = await git.branchLocal();

	if (localBranch.all.includes(newBranch)) {
		throw new Error(`Branch "${newBranch}" already exists`);
	}

	await git.checkoutLocalBranch(newBranch);

	outputCI('newBranch', newBranch);
}
