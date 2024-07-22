import * as core from '@actions/core'
import * as github from '@actions/github'

async function run(): Promise<void> {
  const octokit = github.getOctokit(core.getInput('github_token'))
  const reminderMessage = core.getInput('reminder_message')
  const reviewTurnaroundHours = parseInt(
    core.getInput('review_turnaround_hours'),
    10
  )
  const reviewRollingReminderHours = parseInt(
    core.getInput('review_rolling_reminder_hours'),
    10
  )

  try {
    const {data: pullRequests} = await octokit.pulls.list({
      ...github.context.repo,
      state: 'open'
    })

    for (const pr of pullRequests) {
      core.info(`pr title: ${pr.title}`)
      core.info(`pr number: ${pr.number}`)
      core.info(`pr id: ${pr.id}`)

      const pullRequestResponse = await octokit.graphql<PullRequestResponse>(
        `
        query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              timelineItems(first: 50, itemTypes: [REVIEW_REQUESTED_EVENT]) {
                nodes {
                  __typename
                  ... on ReviewRequestedEvent {
                    createdAt
                  }
                }
              },
              reviews(first: 50, states: [APPROVED, CHANGES_REQUESTED, COMMENTED]) {
                nodes {
                  __typename
                  ... on PullRequestReview {
                    createdAt
                  }
                }
              },
              comments(first: 100) {
                nodes {
                  body
                  createdAt
                }
              }
            }
          }
        }
        `,
        {
          owner: github.context.repo.owner,
          name: github.context.repo.repo,
          number: pr.number
        }
      )

      if (pullRequestResponse.repository.pullRequest.reviews.nodes.length > 0) {
        continue
      }

      if (
        pullRequestResponse.repository.pullRequest.timelineItems.nodes
          .length === 0
      ) {
        continue
      }

      const pullRequestReviewCreatedAt =
        pullRequestResponse.repository.pullRequest.timelineItems.nodes[0]
          .createdAt

      const currentTime = new Date().getTime()
      const reviewByTime =
        new Date(pullRequestReviewCreatedAt).getTime() +
        1000 * 60 * 60 * reviewTurnaroundHours

      core.info(`currentTime: ${currentTime} reviewByTime: ${reviewByTime}`)
      if (currentTime < reviewByTime) {
        continue
      }

      const {data: pullRequest} = await octokit.pulls.get({
        ...github.context.repo,
        pull_number: pr.number
      })

      const reviewers = pullRequest.requested_reviewers
        .map(rr => `@${rr.login}`)
        .join(', ')

      const addReminderComment = `${reviewers} \n${reminderMessage}`
      const hasReminderComment =
        pullRequestResponse.repository.pullRequest.comments.nodes.filter(
          node => {
            return node.body.match(RegExp(reminderMessage)) != null
          }
        ).length > 0

      let shouldRemindAgain = false

      if (hasReminderComment) {
        const reminderComments = pullRequestResponse.repository.pullRequest.comments.nodes.filter(
          node => {
            return node.body.match(RegExp(reminderMessage)) != null
          }
        )
        const lastReminderComment =
          reminderComments[reminderComments.length - 1]

        const remindByTime =
          new Date(lastReminderComment.createdAt).getTime() +
          1000 * 60 * 60 * reviewRollingReminderHours

        core.info(`Remind by time: ${remindByTime}`)

        if (currentTime > remindByTime) {
          shouldRemindAgain = true
        }
      }

      core.info(`hasReminderComment: ${hasReminderComment}`)
      core.info(`shouldRemindAgain: ${shouldRemindAgain}`)
      if (hasReminderComment && !shouldRemindAgain) {
        continue
      }

      await octokit.issues.createComment({
        ...github.context.repo,
        issue_number: pullRequest.number,
        body: addReminderComment
      })

      core.info(
        `create comment issue_number: ${pullRequest.number} body: ${reviewers} ${addReminderComment}`
      )
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

interface PullRequestResponse {
  repository: {
    pullRequest: {
      timelineItems: {
        nodes: Node[]
      }
      reviews: {
        nodes: Node[]
      }
      comments: {
        nodes: {
          body: string
          createdAt: string
        }[]
      }
    }
  }
}

interface Node {
  __typename: string
  createdAt: string
}

run()
