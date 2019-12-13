/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/camelcase */
import Bitbucket from 'bitbucket';
import { grey } from 'colors';
import Debug from 'debug';
import GitUrlParse from 'git-url-parse';
import { inject, injectable } from 'inversify';
import { inspect } from 'util';
import axios from 'axios';
import qs from 'qs';
import { IVCSService, VCSServiceType, BitbucketPullRequestState } from '..';
import { ArgumentsProvider } from '../../scanner';
import { ICache } from '../../scanner/cache/ICache';
import { Types } from '../../types';
import { ListGetterOptions, PullRequestState, Paginated } from '../../inspectors';
import { BitbucketIssueState } from '../../inspectors/IIssueTrackingInspector';
import {
  PullRequest,
  PullFiles,
  PullCommits,
  Issue,
  IssueComment,
  PullRequestReview,
  Commit,
  PullRequestComment,
  CreateUpdatePullRequestComment,
  Contributor,
  ContributorStats,
  Symlink,
  File,
  Directory,
} from '../git/model';
import { VCSServicesUtils } from '../git/VCSServicesUtils';
import { DeepRequired } from '../../lib/deepRequired';
import { InMemoryCache } from '../../scanner/cache';

const debug = Debug('cli:services:git:bitbucket-service');

@injectable()
export class BitbucketService implements IVCSService {
  private readonly client: Bitbucket;
  private cache: ICache;
  private callCount = 0;

  constructor(@inject(Types.ArgumentsProvider) argumentsProvider: ArgumentsProvider) {
    this.cache = new InMemoryCache();

    const clientOptions: Bitbucket.Options = {
      hideNotice: true,
    };

    this.client = new Bitbucket(clientOptions);

    let username: string;
    let password: string | undefined;
    if (argumentsProvider.auth && argumentsProvider.auth.includes(':')) {
      username = argumentsProvider.auth.split(':')[0];
      password = argumentsProvider.auth.split(':')[1];
    } else {
      username = GitUrlParse(argumentsProvider.uri).owner;
      password = argumentsProvider.auth;
    }

    let auth: Bitbucket.Auth;
    if (argumentsProvider.auth) {
      auth = { type: 'apppassword', username, password: password! };
      this.client.authenticate(auth);
    }
  }

  purgeCache() {
    this.cache.purge();
  }

  getRepo(owner: string, repo: string) {
    const params: Bitbucket.Params.RepositoriesGet = {
      repo_slug: repo,
      username: owner,
    };

    return this.unwrap(this.client.repositories.get(params));
  }

  async getPullRequests(
    owner: string,
    repo: string,
    options?: ListGetterOptions<{ state?: PullRequestState }>,
  ): Promise<Paginated<PullRequest>> {
    let state;
    if (options?.filter?.state) {
      state = VCSServicesUtils.getPRState(options.filter.state, VCSServiceType.bitbucket);
    }
    const stateForUri = qs.stringify({ state: state }, { addQueryPrefix: true, indices: false, arrayFormat: 'repeat' });
    let apiUrl = `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}/pullrequests`;
    if (stateForUri) {
      apiUrl = apiUrl.concat(`${stateForUri}`);
    }

    const ownerUrl = `www.bitbucket.org/${owner}`;
    const ownerId = `${(await this.client.users.get({ username: owner })).data.uuid}`;

    const response: DeepRequired<Bitbucket.Response<Bitbucket.Schema.PaginatedPullrequests>> = await axios.get(apiUrl);

    const values = response.data.values.map(async (val) => {
      return {
        user: {
          id: val.author.uuid,
          login: val.author.nickname,
          url: val.author.links.html.href,
        },
        url: val.links.html.href,
        body: val.description,
        createdAt: val.created_on,
        updatedAt: val.updated_on,
        closedAt:
          val.state === BitbucketPullRequestState.closed || val.state === BitbucketPullRequestState.declined ? val.updated_on : null,
        mergedAt: val.state === BitbucketPullRequestState.closed ? val.updated_on : null,
        state: val.state,
        id: val.id,
        base: {
          repo: {
            url: val.destination.repository.links.html.href,
            name: val.destination.repository.name,
            id: val.destination.repository.uuid,
            owner: {
              login: owner,
              id: ownerId,
              url: ownerUrl,
            },
          },
        },
      };
    });

    const pagination = this.getPagination(response.data);

    const items = await Promise.all(values);

    return { items, ...pagination };
  }

  async getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequest> {
    const params = {
      pull_request_id: prNumber,
      repo_slug: repo,
      username: owner,
    };

    const ownerUrl = `www.bitbucket.org/${owner}`;
    const ownerId = `${(await this.client.users.get({ username: owner })).data.uuid}`;

    const response = <DeepRequired<Bitbucket.Response<Bitbucket.Schema.Pullrequest>>>await this.client.pullrequests.get(params);
    response.data;

    return {
      user: {
        id: response.data.author.uuid,
        login: response.data.author.nickname,
        url: response.data.author.links.html.href,
      },
      url: response.data.links.html.href,
      body: response.data.summary.raw,
      createdAt: response.data.created_on,
      updatedAt: response.data.updated_on,
      closedAt:
        response.data.state === BitbucketPullRequestState.closed || response.data.state === BitbucketPullRequestState.declined
          ? response.data.updated_on
          : null,
      mergedAt: response.data.state === BitbucketPullRequestState.closed ? response.data.updated_on : null,
      state: response.data.state,
      id: response.data.id,
      base: {
        repo: {
          url: response.data.destination.repository.links.html.href,
          name: response.data.destination.repository.name,
          id: response.data.destination.repository.uuid,
          owner: {
            login: owner,
            id: ownerId,
            url: ownerUrl,
          },
        },
      },
    };
  }

  async getPullRequestFiles(owner: string, repo: string, prNumber: number): Promise<Paginated<PullFiles>> {
    throw new Error('Method not implemented yet.');
  }

  async getPullCommits(owner: string, repo: string, prNumber: number): Promise<Paginated<PullCommits>> {
    const params: Bitbucket.Params.PullrequestsListCommits = {
      pull_request_id: prNumber.toString(),
      repo_slug: repo,
      username: owner,
    };

    const response = <DeepRequired<Bitbucket.Response<BitbucketCommit>>>await this.client.pullrequests.listCommits(params);

    const items = response.data.values.map((val) => ({
      sha: val.hash,
      commit: {
        url: val.links.html.href,
        message: val.message,
        author: {
          name: val.author.raw,
          email: 'undefined',
          date: val.date,
        },
        tree: {
          sha: val.hash,
          url: val.links.html.href,
        },
        //TODO
        verified: false,
      },
    }));
    const pagination = this.getPagination(response.data);

    return { items, ...pagination };
  }

  async getIssues(owner: string, repo: string): Promise<Paginated<Issue>> {
    const params: Bitbucket.Params.IssueTrackerList = {
      repo_slug: repo,
      username: owner,
    };
    const response = <DeepRequired<Bitbucket.Response<Bitbucket.Schema.PaginatedIssues>>>await this.client.issue_tracker.list(params);

    const items = response.data.values.map((val) => ({
      user: {
        id: val.reporter.uuid,
        login: val.reporter.nickname,
        url: val.reporter.links.html.href,
      },
      url: val.repository.links.html.href,
      body: val.content.raw,
      createdAt: val.created_on,
      updatedAt: val.updated_on,
      closedAt: val.state === BitbucketIssueState.resolved || val.state === BitbucketIssueState.closed ? val.updated_on : null,
      state: val.state,
      id: val.repository.uuid,
    }));
    const pagination = this.getPagination(response.data);

    return { items, ...pagination };
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<Issue> {
    const params: Bitbucket.Params.IssueTrackerGet = {
      issue_id: issueNumber.toString(),
      repo_slug: repo,
      username: owner,
    };
    const response = <DeepRequired<Bitbucket.Response<Bitbucket.Schema.Issue>>>await this.client.issue_tracker.get(params);

    return {
      id: response.data.repository.uuid,
      user: {
        login: response.data.reporter.nickname,
        id: response.data.reporter.uuid,
        url: response.data.reporter.links.html.href,
      },
      url: response.data.links.html.href,
      body: response.data.content.raw,
      createdAt: response.data.created_on,
      updatedAt: response.data.updated_on,
      closedAt:
        response.data.state === BitbucketIssueState.resolved || response.data.state === BitbucketIssueState.closed
          ? response.data.updated_on
          : null,
      state: response.data.state,
    };
  }

  async getIssueComments(owner: string, repo: string, issueNumber: number): Promise<Paginated<IssueComment>> {
    const params: Bitbucket.Params.IssueTrackerListComments = {
      issue_id: issueNumber.toString(),
      repo_slug: repo,
      username: owner,
    };
    const response = <DeepRequired<Bitbucket.Response<Bitbucket.Schema.PaginatedIssueComments>>>(
      await this.client.issue_tracker.listComments(params)
    );

    const items = response.data.values.map((val) => ({
      user: {
        id: val.user.uuid,
        login: val.user.nickname,
        url: val.user.links.html.href,
      },
      url: val.links.html.href,
      body: val.content.raw,
      createdAt: val.created_on,
      updatedAt: val.updated_on,
      authorAssociation: val.author_association,
      id: val.id,
    }));
    const pagination = this.getPagination(response.data);

    return { items, ...pagination };
  }

  async getPullRequestReviews(owner: string, repo: string, prNumber: number): Promise<Paginated<PullRequestReview>> {
    throw new Error('Method not implemented yet.');
  }

  async getRepoCommits(owner: string, repo: string): Promise<Paginated<Commit>> {
    const params: Bitbucket.Params.RepositoriesListCommits = {
      repo_slug: repo,
      username: owner,
    };
    const response = <DeepRequired<Bitbucket.Response<BitbucketCommit>>>await this.client.repositories.listCommits(params);
    const items = response.data.values.map((val) => ({
      sha: val.hash,
      url: val.links.html.href,
      message: val.rendered.message.raw,
      author: {
        name: val.author.user.nickname,
        email: this.extractEmailFromString(val.author.raw) || '',
        date: val.date,
      },
      tree: {
        sha: val.parents[0].hash,
        url: val.parents[0].links.html.href,
      },
      // TODO
      verified: false,
    }));
    const pagination = this.getPagination(response.data);

    return { items, ...pagination };
  }

  async getCommit(owner: string, repo: string, commitSha: string): Promise<Commit> {
    const params: Bitbucket.Params.CommitsGet = {
      node: commitSha,
      repo_slug: repo,
      username: owner,
    };
    const response = <DeepRequired<Bitbucket.Response<Bitbucket.Schema.Commit>>>await this.client.commits.get(params);
    return {
      sha: response.data.hash,
      url: response.data.links.html.href,
      message: response.data.rendered.message.raw,
      author: {
        name: response.data.author.user.nickname,
        email: this.extractEmailFromString(response.data.author.raw) || '',
        date: response.data.date,
      },
      tree: {
        sha: response.data.parents[0].hash,
        url: response.data.parents[0].links.html.href,
      },
      // TODO
      verified: false,
    };
  }

  /**
   * List Comments for a Pull Request
   */
  async getPullRequestComments(owner: string, repo: string, prNumber: number): Promise<Paginated<PullRequestComment>> {
    const response = <DeepRequired<Bitbucket.Response<Bitbucket.Schema.PaginatedPullrequestComments>>>(
      await this.client.pullrequests.listComments({ pull_request_id: prNumber, repo_slug: repo, username: owner })
    );

    const items = response.data.values.map((comment) => ({
      user: { id: comment.user.uuid, login: comment.user.username, url: comment.user.website },
      id: comment.id,
      url: comment.links.html.href,
      body: comment.content.markup,
      createdAt: comment.created_on,
      updatedAt: comment.updated_on,
      authorAssociation: comment.user.username,
    }));

    const pagination = this.getPagination(response.data);
    return { items, ...pagination };
  }

  /**
   * Add Comment to a Pull Request
   */
  async createPullRequestComment(owner: string, repo: string, prNumber: number, body: string): Promise<CreateUpdatePullRequestComment> {
    const response = <DeepRequired<Bitbucket.Response<Bitbucket.Schema.Comment>>>await this.client.pullrequests.createComment({
      pull_request_id: prNumber,
      repo_slug: repo,
      username: owner,
      _body: { type: 'pullrequest_comment', content: { raw: body, markup: 'markdown' } },
    });

    const comment = response.data;
    return {
      user: { id: `${comment.user.id}`, login: comment.user.login, url: comment.user.url },
      id: comment.id,
      url: comment.url,
      body: comment.body,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    };
  }

  /**
   * Update Comment on a Pull Request
   */
  async updatePullRequestComment(
    owner: string,
    repo: string,
    commentId: string,
    body: string,
    pullRequestId: number,
  ): Promise<CreateUpdatePullRequestComment> {
    const response = <DeepRequired<Bitbucket.Response<Bitbucket.Schema.Comment>>>await this.client.pullrequests.updateComment({
      pull_request_id: `${pullRequestId}`,
      comment_id: `${commentId}`,
      repo_slug: repo,
      username: owner,
      _body: { type: 'pullrequest_comment', content: { raw: body, markup: 'markdown' } },
    });

    const comment = response.data;
    return {
      user: { id: `${comment.user.id}`, login: comment.user.login, url: comment.user.url },
      id: comment.id,
      url: comment.url,
      body: comment.body,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    };
  }

  async getContributors(owner: string, repo: string): Promise<Paginated<Contributor>> {
    throw new Error('Method not implemented yet.');
  }

  async getContributorsStats(owner: string, repo: string): Promise<Paginated<ContributorStats>> {
    throw new Error('Method not implemented yet.');
  }

  async getRepoContent(owner: string, repo: string, path: string): Promise<File | Symlink | Directory | null> {
    throw new Error('Method not implemented yet.');
  }

  private unwrap<T>(clientPromise: Promise<Bitbucket.Response<T>>) {
    return clientPromise
      .then((response) => {
        this.debugBitbucketResponse(response);
        return response;
      })
      .catch((error) => {
        if (error.response) {
          debug(`${error.response.status} => ${inspect(error.response.data)}`);
        } else {
          debug(inspect(error));
        }
        throw error;
      });
  }

  private debugBitbucketResponse = <T>(response: Bitbucket.Response<T>) => {
    this.callCount++;
    debug(
      grey(`Bitbucket API Hit: ${this.callCount}. Remaining ${response.headers['x-ratelimit-remaining']} hits. (${response.headers.link})`),
    );
  };

  getPagination<T>(data: { next: string; previous: string; page: number; values: T[] }) {
    const hasNextPage = !!data.next;
    const hasPreviousPage = !!data.previous;
    const page = data.page;
    const perPage = data.values && data.values.length;
    const totalCount = data.values && data.values.length;

    return { totalCount, hasNextPage, hasPreviousPage, page, perPage };
  }

  private extractEmailFromString = (text: string): string | undefined => {
    const emailRegex = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/gim;
    const email = text.match(emailRegex);
    if (email) return email[0];
    return undefined;
  };
}

export interface BitbucketCommit {
  next: string;
  page: number;
  pagelen: number;
  previous: string;
  size: number;
  values: Bitbucket.Schema.Commit[];
}
