/*
 * Copyright 2016 Turner Broadcasting System, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const request = require('request'),
    AWS = require('aws-sdk'),
    FeedGenerator = require('../lib/feed-generator.js'),
    amqp = require('amqplib/callback_api'),
    debugLog = require('debug')('cnn-google-newsstand:Task:google-newsstand-latest'),
    config = require('../config.js'),
    cloudamqpConnectionString = config.get('cloudamqpConnectionString'),
    latestFG = new FeedGenerator(),
    electionsFG = new FeedGenerator(),
    entertainmentFG = new FeedGenerator(),
    healthFG = new FeedGenerator(),
    opinionsFG = new FeedGenerator(),
    politicsFG = new FeedGenerator(),
    techFG = new FeedGenerator(),
    usFG = new FeedGenerator(),
    worldFG = new FeedGenerator(),
    enableElectionStory = config.get('gnsTurnOnElectionModule');


// connect to CloudAMQP and use/create the queue to subscribe to
amqp.connect(cloudamqpConnectionString, (error, connection) => {
    connection.createChannel((error, channel) => {
        const exchangeName = config.get('exchangeName');

        channel.assertExchange(exchangeName, 'topic', {durable: true});

        channel.assertQueue(config.get('queueNameArticles'), {durable: true}, (error, queueName) => {
            const routingKeys = config.get('routingKeysArticles');

            routingKeys.forEach((routingKey) => {
                channel.bindQueue(queueName.queue, exchangeName, routingKey);
            });

            channel.prefetch(1);

            channel.consume(
                queueName.queue,
                (message) => {
                    let mappedToASection = false;

                    debugLog(`AMQP Message: ${message.fields.routingKey}: ${message.content.toString()}`);
                    debugLog(`Adding url to latest feed: ${JSON.parse(message.content.toString()).url}`);
                    latestFG.urls = JSON.parse(message.content.toString()).url;

                    if (/\/entertainment\//.test(JSON.parse(message.content.toString()).url)) {
                        debugLog(`Adding url to entertainment feed: ${JSON.parse(message.content.toString()).url}`);
                        entertainmentFG.urls = JSON.parse(message.content.toString()).url;
                        mappedToASection = true;
                    }

                    if (/\/politics\//.test(JSON.parse(message.content.toString()).url)) {
                        debugLog(`Adding url to politics feed: ${JSON.parse(message.content.toString()).url}`);
                        politicsFG.urls = JSON.parse(message.content.toString()).url;
                        mappedToASection = true;
                    }

                    if (/\/health\//.test(JSON.parse(message.content.toString()).url)) {
                        debugLog(`Adding url to health feed: ${JSON.parse(message.content.toString()).url}`);
                        healthFG.urls = JSON.parse(message.content.toString()).url;
                        mappedToASection = true;
                    }

                    if (/\/opinions|opinion\//.test(JSON.parse(message.content.toString()).url)) {
                        debugLog(`Adding url to opinions feed: ${JSON.parse(message.content.toString()).url}`);
                        opinionsFG.urls = JSON.parse(message.content.toString()).url;
                        mappedToASection = true;
                    }

                    if (/\/tech\//.test(JSON.parse(message.content.toString()).url)) {
                        debugLog(`Adding url to tech feed: ${JSON.parse(message.content.toString()).url}`);
                        techFG.urls = JSON.parse(message.content.toString()).url;
                        mappedToASection = true;
                    }

                    if (/\/us|crime|justice\//.test(JSON.parse(message.content.toString()).url)) {
                        debugLog(`Adding url to us feed: ${JSON.parse(message.content.toString()).url}`);
                        usFG.urls = JSON.parse(message.content.toString()).url;
                        mappedToASection = true;
                    }

                    if (/\/world\//.test(JSON.parse(message.content.toString()).url)) {
                        debugLog(`Adding url to world feed: ${JSON.parse(message.content.toString()).url}`);
                        worldFG.urls = JSON.parse(message.content.toString()).url;
                        mappedToASection = true;
                    }

                    if (JSON.parse(message.content.toString()).branding && JSON.parse(message.content.toString()).branding === '2016-elections') {
                        debugLog(`Adding url to election feed: ${JSON.parse(message.content.toString()).url}`);
                        electionsFG.urls = JSON.parse(message.content.toString()).url;
                        mappedToASection = true;
                    }

                    if (!mappedToASection) {
                        debugLog(`${JSON.parse(message.content.toString()).url} - DEFAULTING to world feed`);
                        worldFG.urls = JSON.parse(message.content.toString()).url;
                    }

                    channel.ack(message);
                },
                {noAck: false, exclusive: true}
            );
        });
    });
});

let s3Images = undefined;

function filterImages(data) {
    let filteredImages = [],
        contents = data.Contents,
        image,
        i;
    for (i in contents) {
        image = contents[i];
        if (image.Key.includes('.png')) {
            filteredImages.push({
                time: image.LastModified,
                url: `http://registry.api.cnn.io/${image.Key}`
            });
        }
    }

    filteredImages = filteredImages.sort(function (a, b) {
        return new Date(b.time) - new Date(a.time);
    });

    return filteredImages;
}


function getImagesFromAWS() {
    return new Promise(function (fulfill) {

        let awsConfig = {accessKeyId: config.get('aws').accessKeyId, secretAccessKey: config.get('aws').secretAccessKey, region: 'us-east-1'},
            bucket = config.get('aws').bucket,
            s3obj,
            prefixStr = `assets/img/opp/ksa/${config.get('gnsElectiomImgEnv')}/gns/`,
            params = {Bucket: bucket, Prefix: prefixStr};

        AWS.config.update(awsConfig);
        s3obj = new AWS.S3();

        s3obj.listObjects(params, (err, data) => {
            if (err) {
                console.log('Error retrieving images from s3');
                fulfill({error: 'Error retrieving images from s3'});
            } else {
                console.log('Successfully retrieved images from s3');
                fulfill(filterImages(data));
            }
        });
    });
}

function isConstantPublishedAlreadyThere(urls, electionStoryUrl) {
    let isStoryThere = false;

    if (urls && urls.length && urls.length > 0) {
        urls.some((url) => {
            if (electionStoryUrl === url) {
                isStoryThere = true;
            }
        });
    }

    return isStoryThere;
}


if ((enableElectionStory === true || enableElectionStory === 'true')
    || (config.get('gnsElectionModuleTest') === true || config.get('gnsElectionModuleTest') === 'true')) {
    s3Images = getImagesFromAWS();
}

function postToLSD(data, feedName) {
    let suffix = (config.get('ENVIRONMENT') === 'prod') ? '' : `-${config.get('ENVIRONMENT')}`,
        endpoint = `/cnn/content/google-newsstand/${feedName}${suffix}.xml`,
        hosts = config.get('lsdHosts');

    debugLog('postToLSD() called');
    // debugLog(data);

    hosts.split(',').forEach((host) => {
        request.post({
            url: `http://${host}${endpoint}`,
            body: data,
            headers: {'Content-Type': 'application/rss+xml'}
        },
        (error/* , response, body*/) => {
            if (error) {
                debugLog(error.stack);
            } else {
                debugLog(`Successfully uploaded data to ${hosts} at ${endpoint}`);
                // debugLog(body);
            }
        });
    });
}


// brute force.  This is not the final solution, but it works just fine
setInterval(() => {
    debugLog('Generate latest Feed interval fired');

    if ((enableElectionStory === true || enableElectionStory === 'true')  && s3Images) {
        let constantElectionStoryUpdate = config.get('gnsElectionStoryConstantUpdate'),
            constantElectionStoryUpdateURL = config.get('gnsElectionStoryConstantUpdateURL');

        if ((constantElectionStoryUpdate === 'true' || constantElectionStoryUpdate === true)
            && constantElectionStoryUpdateURL) {
            if (!isConstantPublishedAlreadyThere(latestFG.urls, constantElectionStoryUpdateURL)) {
                latestFG.urls = constantElectionStoryUpdateURL;
            }
        }
    }

    if (latestFG.urls && latestFG.urls.length > 0) {

        if (config.get('gnsTurnOnElectionModule') === true || config.get('gnsTurnOnElectionModule') === 'true') {
            s3Images = getImagesFromAWS();
            s3Images.then(function (data) {

                let electionData = {
                    s3Data: data
                };

                latestFG.processContent(electionData).then(
                    // success
                    (rssFeed) => {
                        console.log(rssFeed);

                        postToLSD(rssFeed, 'latest');

                        // post to LSD endpoint
                        latestFG.urls = 'clear';
                        debugLog(latestFG.urls);
                    },

                    // failure
                    (error) => {
                        console.log(error);
                    }
                );
            });
        } else {
            latestFG.processContent().then(
                // success
                (rssFeed) => {
                    console.log(rssFeed);

                    postToLSD(rssFeed, 'latest');

                    // post to LSD endpoint
                    latestFG.urls = 'clear';
                    debugLog(latestFG.urls);
                },

                // failure
                (error) => {
                    console.log(error);
                }
            );
        }
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));

setInterval(() => {
    debugLog('Generate entertainment Feed interval fired');

    if (entertainmentFG.urls && entertainmentFG.urls.length > 0) {
        entertainmentFG.processContent().then(
            // success
            (rssFeed) => {
                console.log(rssFeed);

                postToLSD(rssFeed, 'entertainment');

                // post to LSD endpoint
                entertainmentFG.urls = 'clear';
                debugLog(entertainmentFG.urls);
            },

            // failure
            (error) => {
                console.log(error);
            }
        );
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));

setInterval(() => {
    debugLog('Generate health Feed interval fired');

    if (healthFG.urls && healthFG.urls.length > 0) {
        healthFG.processContent().then(
            // success
            (rssFeed) => {
                console.log(rssFeed);

                postToLSD(rssFeed, 'health');

                // post to LSD endpoint
                healthFG.urls = 'clear';
                debugLog(healthFG.urls);
            },

            // failure
            (error) => {
                console.log(error);
            }
        );
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));

setInterval(() => {
    debugLog('Generate opinions Feed interval fired');

    if (opinionsFG.urls && opinionsFG.urls.length > 0) {
        opinionsFG.processContent().then(
            // success
            (rssFeed) => {
                console.log(rssFeed);

                postToLSD(rssFeed, 'opinions');

                // post to LSD endpoint
                opinionsFG.urls = 'clear';
                debugLog(opinionsFG.urls);
            },

            // failure
            (error) => {
                console.log(error);
            }
        );
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));

setInterval(() => {
    debugLog('Generate politics Feed interval fired');

    if ((enableElectionStory === true || enableElectionStory === 'true')  && s3Images) {
        let constantElectionStoryUpdate = config.get('gnsElectionStoryConstantUpdate'),
            constantElectionStoryUpdateURL = config.get('gnsElectionStoryConstantUpdateURL');


        if ((constantElectionStoryUpdate === 'true' || constantElectionStoryUpdate === true)
            && constantElectionStoryUpdateURL) {
            if (!isConstantPublishedAlreadyThere(politicsFG.urls, constantElectionStoryUpdateURL)) {
                politicsFG.urls = constantElectionStoryUpdateURL;
            }
        }
    }

    if (politicsFG.urls && politicsFG.urls.length > 0) {

        if (config.get('gnsTurnOnElectionModule') === true || config.get('gnsTurnOnElectionModule') === 'true') {
            s3Images = getImagesFromAWS();
            s3Images.then(function (data) {

                let electionData = {
                    s3Data: data
                };

                politicsFG.processContent(electionData).then(
                    // success
                    (rssFeed) => {
                        console.log(rssFeed);

                        postToLSD(rssFeed, 'politics');

                        // post to LSD endpoint
                        politicsFG.urls = 'clear';
                        debugLog(politicsFG.urls);
                    },

                    // failure
                    (error) => {
                        console.log(error);
                    }
                );
            });
        } else {
            politicsFG.processContent().then(
                // success
                (rssFeed) => {
                    console.log(rssFeed);

                    postToLSD(rssFeed, 'politics');

                    // post to LSD endpoint
                    politicsFG.urls = 'clear';
                    debugLog(politicsFG.urls);
                },

                // failure
                (error) => {
                    console.log(error);
                }
            );
        }
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));

setInterval(() => {
    debugLog('Generate tech Feed interval fired');

    if (techFG.urls && techFG.urls.length > 0) {
        techFG.processContent().then(
            // success
            (rssFeed) => {
                console.log(rssFeed);

                postToLSD(rssFeed, 'tech');

                // post to LSD endpoint
                techFG.urls = 'clear';
                debugLog(techFG.urls);
            },

            // failure
            (error) => {
                console.log(error);
            }
        );
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));

setInterval(() => {
    debugLog('Generate us Feed interval fired');

    if (usFG.urls && usFG.urls.length > 0) {
        usFG.processContent().then(
            // success
            (rssFeed) => {
                console.log(rssFeed);

                postToLSD(rssFeed, 'us');

                // post to LSD endpoint
                usFG.urls = 'clear';
                debugLog(usFG.urls);
            },

            // failure
            (error) => {
                console.log(error);
            }
        );
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));

setInterval(() => {
    debugLog('Generate world Feed interval fired');

    if (worldFG.urls && worldFG.urls.length > 0) {
        worldFG.processContent().then(
            // success
            (rssFeed) => {
                console.log(rssFeed);

                postToLSD(rssFeed, 'world');

                // post to LSD endpoint
                worldFG.urls = 'clear';
                debugLog(worldFG.urls);
            },

            // failure
            (error) => {
                console.log(error);
            }
        );
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));

setInterval(() => {
    debugLog('Generate election Feed interval fired');

    if ((enableElectionStory === true || enableElectionStory === 'true')
        || (config.get('gnsElectionModuleTest') === true || config.get('gnsElectionModuleTest') === 'true')
        && s3Images) {
        let constantElectionStoryUpdate = config.get('gnsElectionStoryConstantUpdate'),
            constantElectionStoryUpdateURL = config.get('gnsElectionStoryConstantUpdateURL');


        if ((constantElectionStoryUpdate === 'true' || constantElectionStoryUpdate === true) ||
            (config.get('gnsElectionModuleTest') === true || config.get('gnsElectionModuleTest') === 'true')
            && constantElectionStoryUpdateURL) {
            if (!isConstantPublishedAlreadyThere(electionsFG.urls, constantElectionStoryUpdateURL)) {
                electionsFG.urls = constantElectionStoryUpdateURL;
                console.log('constant election story update added for: ', constantElectionStoryUpdateURL, 'election URL array: ', electionsFG.urls);
            }
        }
    }

    if (electionsFG.urls && electionsFG.urls.length > 0) {
        if ((enableElectionStory === true || enableElectionStory === 'true') || (config.get('gnsElectionModuleTest') === true || config.get('gnsElectionModuleTest') === 'true') && s3Images) {
            s3Images = getImagesFromAWS();
            s3Images.then(function (data) {

                let electionData = {
                    s3Data: data,
                    electionTest: config.get('gnsElectionModuleTest')
                };

                electionsFG.processContent(electionData).then(
                    // success
                    (rssFeed) => {
                        console.log(rssFeed);

                        postToLSD(rssFeed, '2016-elections');

                        // post to LSD endpoint
                        electionsFG.urls = 'clear';
                        debugLog(electionsFG.urls);
                    },

                    // failure
                    (error) => {
                        console.log(error);
                    }
                );
            });
        } else {
            electionsFG.processContent().then(
                // success
                (rssFeed) => {
                    console.log(rssFeed);

                    postToLSD(rssFeed, '2016-elections');

                    // post to LSD endpoint
                    electionsFG.urls = 'clear';
                    debugLog(electionsFG.urls);
                },

                // failure
                (error) => {
                    console.log(error);
                }
            );
        }
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));
