import * as core from '@actions/core'
import * as github from '@actions/github'

function haveBusinessDaysPassed(
  pullRequestReviewCreatedAt: number,
  businessDays: number
): boolean {
  const oneDayInMs = 24 * 60 * 60 * 1000 // Milliseconds in one day

  // Convert pullRequestReviewCreatedAt to milliseconds to match current time format
  const startDate = new Date(pullRequestReviewCreatedAt * 1000)
  const endDate = new Date() // Get the current date and time

  let businessDaysCount = 0

  // Loop through each day between startDate and endDate
  let currentDate = startDate

  while (currentDate < endDate) {
    const dayOfWeek = currentDate.getDay()

    // Check if it's a weekday (Monday to Friday)
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      businessDaysCount++
    }

    // Stop early if we already have X business days
    if (businessDaysCount >= businessDays) {
      return true
    }

    // Move to the next day
    currentDate = new Date(currentDate.getTime() + oneDayInMs)
  }

  // If less than 2 business days were found
  return false
}

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

      if (
        !haveBusinessDaysPassed(
          new Date(pullRequestReviewCreatedAt).getTime(),
          reviewTurnaroundHours / 24
        )
      ) {
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

        if (
          haveBusinessDaysPassed(
            new Date(lastReminderComment.createdAt).getTime(),
            reviewRollingReminderHours / 24
          )
        ) {
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
