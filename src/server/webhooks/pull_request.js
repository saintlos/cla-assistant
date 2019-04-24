require('../documents/user');

// services
let pullRequest = require('../services/pullRequest');
let status = require('../services/status');
let cla = require('../services/cla');
let repoService = require('../services/repo');
let logger = require('../services/logger');
let config = require('../../config');
let User = require('mongoose').model('User');
const promisify = require('../util').promisify;
const promiseDelay = require('../util').promiseDelay;


//////////////////////////////////////////////////////////////////////////////////////////////
// GitHub Pull Request Webhook Handler
//////////////////////////////////////////////////////////////////////////////////////////////

function storeRequest(committers, repo, owner, number) {
    return Promise.all(committers.map(async committer => {
        const [ user ] = await promisify(User.findOne.bind(User))({ name: committer });
        const pullRequest = { repo: repo, owner: owner, numbers: [number] };
        if (!user) {
            return promisify(User.create.bind(User))({ name: committer, requests: [pullRequest] });
        }
        if (!user.requests || user.requests.length < 1) {
            user.requests = user.requests ? user.requests : [];
            user.requests.push(pullRequest);

            return user.save();
        }
        const repoPullRequests = user.requests.find((request) => {
            return request.repo === repo && request.owner === owner;
        });
        if (repoPullRequests && repoPullRequests.numbers.indexOf(number) < 0) {
            repoPullRequests.numbers.push(number);

            return user.save();
        }
        if (!repoPullRequests) {
            user.requests.push(pullRequest);

            return user.save();
        }
    }));
}

async function updateStatusAndComment(args) {
    try {
        const [committers] = await promisify(repoService.getPRCommitters.bind(repoService))(args);
        if (!committers || committers.length === 0) {
            throw new Error('Cannot get committers of the pull request');
        }
        const [signed, user_map] = await promisify(cla.check.bind(cla))(args);
        args.signed = signed;
        if (!user_map ||
            (user_map.signed && user_map.signed.length > 0) ||
            (user_map.not_signed && user_map.not_signed.length > 0) ||
            (user_map.unknown && user_map.unknown.length > 0)
        ) {
            await promisify(status.update.bind(status))(args);
        } else {
            await promisify(status.updateForClaNotRequired.bind(status))(args);
        }
        if (!signed || config.server.feature_flag.close_comment !== 'true') {
            await promisify(pullRequest.badgeComment.bind(pullRequest))(
                args.owner,
                args.repo,
                args.number,
                signed,
                user_map
            );
        }
        if (user_map && user_map.not_signed) {
            await promisify(storeRequest)(user_map.not_signed, args.repo, args.owner, args.number);
        }
    } catch (err) {
        if (!args.handleCount || args.handleCount < 2) {
            args.handleCount = args.handleCount ? ++args.handleCount : 1;
            await promiseDelay(10000 * args.handleCount * args.handleDelay);
            await updateStatusAndComment(args);
        } else {
            logger.warn(new Error(err).stack, 'called with args: ', { repo: args.repo, owner: args.owner, number: args.number, handleCount: args.handleCount });
            throw err;
        }
    }
}

async function handleWebHook(args) {
    try {
        args.isClaRequired = await cla.isClaRequired(args);
        if (args.isClaRequired) {
            await updateStatusAndComment(args);
        } else {
            await promisify(status.updateForClaNotRequired.bind(status))(args);
            await promisify(pullRequest.deleteComment.bind(pullRequest))({
                repo: args.repo,
                owner: args.owner,
                number: args.number
            });
        }
    } catch (error) {
        logger.error(error, { repo: args.repo, owner: args.owner, number:args.number, sha: args.sha, signed: args.signed });
        throw error;
    }
}

module.exports = function (req, res) {
    if (['opened', 'reopened', 'synchronize'].indexOf(req.args.action) > -1 && (req.args.repository && req.args.repository.private == false)) {
        if (req.args.pull_request && req.args.pull_request.html_url) {
            logger.info('pull request ' + req.args.action + ' ' + req.args.pull_request.html_url);
        }
        let args = {
            owner: req.args.repository.owner.login,
            repoId: req.args.repository.id,
            repo: req.args.repository.name,
            number: req.args.number
        };
        args.orgId = req.args.organization ? req.args.organization.id : req.args.repository.owner.id;
        args.handleDelay = req.args.handleDelay != undefined ? req.args.handleDelay : 1; // needed for unitTests


        setTimeout(async function () {
            try {
                const item = await cla.getLinkedItem(args);
                let nullCla = !item.gist;
                let isExcluded = item.orgId && item.isRepoExcluded && item.isRepoExcluded(args.repo);
                if (nullCla || isExcluded) {
                    return;
                }
                args.token = item.token;
                args.gist = item.gist;
                if (item.repoId) {
                    args.orgId = undefined;
                }
                await handleWebHook(args);
            } catch (e) {
                logger.error(e, 'CLAAssistantHandleWebHookFail', { owner: args.owner, repo: args.repo, number: args.number });
            }
        }, config.server.github.enforceDelay);
    }

    res.status(200).send('OK');
};