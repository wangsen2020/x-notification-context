import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractEntries,
  parseNotificationsTimeline,
  fetchFxTwitterStatus,
  normalizeStatusUrl
} from '../src/parser.js';

function makeResponse({ status = 200, redirected = false, contentType = 'application/json', body = {} } = {}) {
  return {
    status,
    redirected,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? contentType : null;
      }
    },
    async json() {
      if (body instanceof Error) throw body;
      return body;
    }
  };
}

test('normalizeStatusUrl upgrades twitter.com and builds fallback /i/web URLs', () => {
  assert.equal(
    normalizeStatusUrl('https://twitter.com/alice/status/12345', '12345', 'alice'),
    'https://x.com/alice/status/12345'
  );
  assert.equal(normalizeStatusUrl('', '12345', '@alice'), 'https://x.com/alice/status/12345');
  assert.equal(normalizeStatusUrl('', '12345', ''), 'https://x.com/i/web/status/12345');
  assert.equal(normalizeStatusUrl('', '12345', 'invalid_handle_too_long'), 'https://x.com/i/web/status/12345');
});

test('parseNotificationsTimeline extracts target_objects posts and reply parent mappings across instructions', () => {
  const payload = {
    data: {
      viewer_v2: {
        user_results: {
          result: {
            notification_timeline: {
              timeline: {
                instructions: [
                  {
                    type: 'TimelineAddEntries',
                    entries: [
                      {
                        entryId: 'notif-like-1',
                        content: {
                          itemContent: {
                            notification_url: { url: 'https://x.com/me/status/1001' },
                            template: {
                              target_objects: [
                                {
                                  tweet_results: {
                                    result: {
                                      rest_id: '1001',
                                      core: { user_results: { result: { core: { screen_name: 'me' } } } },
                                      note_tweet: {
                                        note_tweet_results: {
                                          result: { text: 'Full long-form original post text' }
                                        }
                                      }
                                    }
                                  }
                                }
                              ]
                            }
                          }
                        }
                      },
                      {
                        entryId: 'notif-reply-cached',
                        content: {
                          clientEventInfo: { element: 'user_replied_to_your_tweet' },
                          itemContent: {
                            __typename: 'TimelineTweet',
                            tweet_results: {
                              result: {
                                rest_id: '2001',
                                legacy: {
                                  id_str: '2001',
                                  in_reply_to_status_id_str: '1001',
                                  in_reply_to_screen_name: 'me',
                                  full_text: 'Totally agree!'
                                }
                              }
                            }
                          }
                        }
                      },
                      {
                        entryId: 'notif-reply-missing-1',
                        content: {
                          itemContent: {
                            __typename: 'TimelineTweet',
                            tweet_results: {
                              result: {
                                tweet: {
                                  rest_id: '2002',
                                  legacy: {
                                    in_reply_to_status_id_str: '1002',
                                    in_reply_to_screen_name: 'me'
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    ]
                  },
                  {
                    type: 'TimelineAddToModule',
                    moduleItems: [
                      {
                        entryId: 'notif-reply-missing-dup',
                        item: {
                          itemContent: {
                            __typename: 'TimelineTweet',
                            tweet_results: {
                              result: {
                                rest_id: '2003',
                                legacy: {
                                  in_reply_to_status_id_str: '1002',
                                  in_reply_to_screen_name: 'me'
                                }
                              }
                            }
                          }
                        }
                      }
                    ]
                  },
                  {
                    type: 'TimelineReplaceEntry',
                    entry: {
                      entryId: 'notif-reply-conv-fallback',
                      content: {
                        clientEventInfo: { element: 'user_replied_to_your_tweet' },
                        itemContent: {
                          tweet_results: {
                            result: {
                              rest_id: '2004',
                              legacy: {
                                conversation_id_str: '1003',
                                in_reply_to_screen_name: 'other'
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                ]
              }
            }
          }
        }
      }
    }
  };

  assert.equal(extractEntries(payload).length, 5);
  const parsed = parseNotificationsTimeline(payload);
  assert.deepEqual(parsed.posts['1001'], {
    text: 'Full long-form original post text',
    url: 'https://x.com/me/status/1001'
  });
  assert.deepEqual(parsed.replies['2001'], {
    targetTweetId: '1001',
    targetHandle: 'me',
    targetUrl: 'https://x.com/me/status/1001'
  });
  assert.deepEqual(parsed.replies['2002'], {
    targetTweetId: '1002',
    targetHandle: 'me',
    targetUrl: 'https://x.com/me/status/1002'
  });
  assert.deepEqual(parsed.replies['2004'], {
    targetTweetId: '1003',
    targetHandle: 'other',
    targetUrl: 'https://x.com/other/status/1003'
  });
  // 1001 is already resolved in target_objects; 1002 is deduplicated across 2002 and 2003
  assert.deepEqual(parsed.missingTargets, [
    { tweetId: '1002', handle: 'me' },
    { tweetId: '1003', handle: 'other' }
  ]);
});

test('fetchFxTwitterStatus validates params, enforces JSON, and handles 200/404 cleanly', async () => {
  let called = 0;
  const badIdRes = await fetchFxTwitterStatus('me', 'abc', {
    fetchImpl: async () => {
      called++;
      return makeResponse();
    }
  });
  assert.equal(badIdRes.ok, false);
  assert.equal(called, 0);

  let requestedUrl = '';
  const okRes = await fetchFxTwitterStatus('this_handle_is_over_fifteen_chars', '999888', {
    fetchImpl: async (url) => {
      requestedUrl = url;
      return makeResponse({
        body: {
          code: 200,
          tweet: {
            url: 'https://x.com/someone/status/999888',
            raw_text: { text: 'Original post from FxTwitter' },
            author: { screen_name: 'someone' }
          }
        }
      });
    }
  });
  assert.equal(requestedUrl, 'https://api.fxtwitter.com/i/status/999888');
  assert.equal(okRes.ok, true);
  assert.equal(okRes.exists, true);
  assert.equal(okRes.text, 'Original post from FxTwitter');
  assert.equal(okRes.url, 'https://x.com/someone/status/999888');

  const notFoundRes = await fetchFxTwitterStatus('someone', '999888', {
    fetchImpl: async () => makeResponse({ body: { code: 404, message: 'NOT_FOUND' } })
  });
  assert.equal(notFoundRes.ok, true);
  assert.equal(notFoundRes.status, 404);
  assert.equal(notFoundRes.exists, false);

  const htmlRes = await fetchFxTwitterStatus('someone', '999888', {
    fetchImpl: async () => makeResponse({ contentType: 'text/html', body: {} })
  });
  assert.equal(htmlRes.ok, false);
  assert.match(htmlRes.error, /Non-JSON/);
});
