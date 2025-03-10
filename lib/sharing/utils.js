/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const { join, dirname, readJson } = require("../util/fs");

/** @typedef {import("../util/fs").InputFileSystem} InputFileSystem */

// Extreme shorthand only for github. eg: foo/bar
const RE_URL_GITHUB_EXTREME_SHORT = /^[^/@:.\s][^/@:\s]*\/[^@:\s]*[^/@:\s]#\S+/;

// Short url with specific protocol. eg: github:foo/bar
const RE_GIT_URL_SHORT = /^(github|gitlab|bitbucket|gist):\/?[^/.]+\/?/;

// Currently supported protocols
const RE_PROTOCOL =
	/^((git\+)?(ssh|https?|file)|git|github|gitlab|bitbucket|gist):$/;

// Has custom protocol
const RE_CUSTOM_PROTOCOL = /^((git\+)?(ssh|https?|file)|git):\/\//;

// Valid hash format for npm / yarn ...
const RE_URL_HASH_VERSION = /#(?:semver:)?(.+)/;

// Simple hostname validate
const RE_HOSTNAME = /^(?:[^/.]+(\.[^/]+)+|localhost)$/;

// For hostname with colon. eg: ssh://user@github.com:foo/bar
const RE_HOSTNAME_WITH_COLON =
	/([^/@#:.]+(?:\.[^/@#:.]+)+|localhost):([^#/0-9]+)/;

// Reg for url without protocol
const RE_NO_PROTOCOL = /^([^/@#:.]+(?:\.[^/@#:.]+)+)/;

// Specific protocol for short url without normal hostname
const PROTOCOLS_FOR_SHORT = [
	"github:",
	"gitlab:",
	"bitbucket:",
	"gist:",
	"file:"
];

// Default protocol for git url
const DEF_GIT_PROTOCOL = "git+ssh://";

// thanks to https://github.com/npm/hosted-git-info/blob/latest/git-host-info.js
const extractCommithashByDomain = {
	"github.com": (pathname, hash) => {
		let [, user, project, type, commithash] = pathname.split("/", 5);
		if (type && type !== "tree") {
			return;
		}

		if (!type) {
			commithash = hash;
		} else {
			commithash = "#" + commithash;
		}

		if (project && project.endsWith(".git")) {
			project = project.slice(0, -4);
		}

		if (!user || !project) {
			return;
		}

		return commithash;
	},
	"gitlab.com": (pathname, hash) => {
		const path = pathname.slice(1);
		if (path.includes("/-/") || path.includes("/archive.tar.gz")) {
			return;
		}

		const segments = path.split("/");
		let project = segments.pop();
		if (project.endsWith(".git")) {
			project = project.slice(0, -4);
		}

		const user = segments.join("/");
		if (!user || !project) {
			return;
		}

		return hash;
	},
	"bitbucket.org": (pathname, hash) => {
		let [, user, project, aux] = pathname.split("/", 4);
		if (["get"].includes(aux)) {
			return;
		}

		if (project && project.endsWith(".git")) {
			project = project.slice(0, -4);
		}

		if (!user || !project) {
			return;
		}

		return hash;
	},
	"gist.github.com": (pathname, hash) => {
		let [, user, project, aux] = pathname.split("/", 4);
		if (aux === "raw") {
			return;
		}

		if (!project) {
			if (!user) {
				return;
			}

			project = user;
			user = null;
		}

		if (project.endsWith(".git")) {
			project = project.slice(0, -4);
		}

		return hash;
	}
};

/**
 * extract commit hash from parsed url
 *
 * @inner
 * @param {Object} urlParsed parsed url
 * @returns {string} commithash
 */
function getCommithash(urlParsed) {
	let { hostname, pathname, hash } = urlParsed;
	hostname = hostname.replace(/^www\./, "");

	try {
		hash = decodeURIComponent(hash);
		// eslint-disable-next-line no-empty
	} catch (e) {}

	if (extractCommithashByDomain[hostname]) {
		return extractCommithashByDomain[hostname](pathname, hash) || "";
	}

	return hash;
}

/**
 * make url right for URL parse
 *
 * @inner
 * @param {string} gitUrl git url
 * @returns {string} fixed url
 */
function correctUrl(gitUrl) {
	// like:
	// proto://hostname.com:user/repo -> proto://hostname.com/user/repo
	return gitUrl.replace(RE_HOSTNAME_WITH_COLON, "$1/$2");
}

/**
 * make url protocol right for URL parse
 *
 * @inner
 * @param {string} gitUrl git url
 * @returns {string} fixed url
 */
function correctProtocol(gitUrl) {
	// eg: github:foo/bar#v1.0. Should not add double slash, in case of error parsed `pathname`
	if (RE_GIT_URL_SHORT.test(gitUrl)) {
		return gitUrl;
	}

	// eg: user@github.com:foo/bar
	if (!RE_CUSTOM_PROTOCOL.test(gitUrl)) {
		return `${DEF_GIT_PROTOCOL}${gitUrl}`;
	}

	return gitUrl;
}

/**
 * extract git dep version from hash
 *
 * @inner
 * @param {string} hash hash
 * @returns {string} git dep version
 */
function getVersionFromHash(hash) {
	const matched = hash.match(RE_URL_HASH_VERSION);

	return (matched && matched[1]) || "";
}

/**
 * if string can be decoded
 *
 * @inner
 * @param {string} str str to be checked
 * @returns {boolean} if can be decoded
 */
function canBeDecoded(str) {
	try {
		decodeURIComponent(str);
	} catch (e) {
		return false;
	}

	return true;
}

/**
 * get right dep version from git url
 *
 * @inner
 * @param {string} gitUrl git url
 * @returns {string} dep version
 */
function getGitUrlVersion(gitUrl) {
	let oriGitUrl = gitUrl;
	// github extreme shorthand
	if (RE_URL_GITHUB_EXTREME_SHORT.test(gitUrl)) {
		gitUrl = "github:" + gitUrl;
	} else {
		gitUrl = correctProtocol(gitUrl);
	}

	gitUrl = correctUrl(gitUrl);

	let parsed;
	try {
		parsed = new URL(gitUrl);
		// eslint-disable-next-line no-empty
	} catch (e) {}

	if (!parsed) {
		return "";
	}

	const { protocol, hostname, pathname, username, password } = parsed;
	if (!RE_PROTOCOL.test(protocol)) {
		return "";
	}

	// pathname shouldn't be empty or URL malformed
	if (!pathname || !canBeDecoded(pathname)) {
		return "";
	}

	// without protocol, there should have auth info
	if (RE_NO_PROTOCOL.test(oriGitUrl) && !username && !password) {
		return "";
	}

	if (!PROTOCOLS_FOR_SHORT.includes(protocol)) {
		if (!RE_HOSTNAME.test(hostname)) {
			return "";
		}

		const commithash = getCommithash(parsed);
		return getVersionFromHash(commithash) || commithash;
	}

	// for protocol short
	return getVersionFromHash(gitUrl);
}

/**
 * @param {string} str maybe required version
 * @returns {boolean} true, if it looks like a version
 */
function isRequiredVersion(str) {
	return /^([\d^=v<>~]|[*xX]$)/.test(str);
}

exports.isRequiredVersion = isRequiredVersion;

/**
 * @see https://docs.npmjs.com/cli/v7/configuring-npm/package-json#urls-as-dependencies
 * @param {string} versionDesc version to be normalized
 * @returns {string} normalized version
 */
function normalizeVersion(versionDesc) {
	versionDesc = (versionDesc && versionDesc.trim()) || "";

	if (isRequiredVersion(versionDesc)) {
		return versionDesc;
	}

	// add handle for URL Dependencies
	return getGitUrlVersion(versionDesc.toLowerCase());
}

exports.normalizeVersion = normalizeVersion;

/**
 *
 * @param {InputFileSystem} fs file system
 * @param {string} directory directory to start looking into
 * @param {string[]} descriptionFiles possible description filenames
 * @param {function(Error=, {data: object, path: string}=): void} callback callback
 */
const getDescriptionFile = (fs, directory, descriptionFiles, callback) => {
	let i = 0;
	const tryLoadCurrent = () => {
		if (i >= descriptionFiles.length) {
			const parentDirectory = dirname(fs, directory);
			if (!parentDirectory || parentDirectory === directory) return callback();
			return getDescriptionFile(
				fs,
				parentDirectory,
				descriptionFiles,
				callback
			);
		}
		const filePath = join(fs, directory, descriptionFiles[i]);
		readJson(fs, filePath, (err, data) => {
			if (err) {
				if ("code" in err && err.code === "ENOENT") {
					i++;
					return tryLoadCurrent();
				}
				return callback(err);
			}
			if (!data || typeof data !== "object" || Array.isArray(data)) {
				return callback(
					new Error(`Description file ${filePath} is not an object`)
				);
			}
			callback(null, { data, path: filePath });
		});
	};
	tryLoadCurrent();
};
exports.getDescriptionFile = getDescriptionFile;

exports.getRequiredVersionFromDescriptionFile = (data, packageName) => {
	if (
		data.optionalDependencies &&
		typeof data.optionalDependencies === "object" &&
		packageName in data.optionalDependencies
	) {
		return normalizeVersion(data.optionalDependencies[packageName]);
	}
	if (
		data.dependencies &&
		typeof data.dependencies === "object" &&
		packageName in data.dependencies
	) {
		return normalizeVersion(data.dependencies[packageName]);
	}
	if (
		data.peerDependencies &&
		typeof data.peerDependencies === "object" &&
		packageName in data.peerDependencies
	) {
		return normalizeVersion(data.peerDependencies[packageName]);
	}
	if (
		data.devDependencies &&
		typeof data.devDependencies === "object" &&
		packageName in data.devDependencies
	) {
		return normalizeVersion(data.devDependencies[packageName]);
	}
};
