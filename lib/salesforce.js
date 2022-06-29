//@ts-check

const jsforce = require('jsforce');

//connection strings to Salesforce for Sandbox + Live
const salesforceProduction = {
    loginUrl: 'https://login.salesforce.com',
    username: 'it@hollyburn.com',
    password: 'EA1q3v@cp9SFF!Mj<^##'
}
const salesforceSandbox = {
    loginUrl: 'https://test.salesforce.com',
    username: 'it@hollyburn.com.develop',
    password: 'Hollyburn2!'
}
//the salesforce connection object that will be created by the authentication method and used when connecting to Salesforce.
let sfConnection;
let sfConnectionCredentials;

async function upsertRecord(salesforceObject, objectData, externalId) {
    return new Promise((resolve, reject) => {
        sfConnection.sobject(salesforceObject).upsert(objectData, externalId, (error, response) => {
            if (error) {
                reject(error);
            }
            else {
                resolve(response);
            }
        })
    })
}

//connection to Salesforce
class Salesforce {

    //all of the jobs/batches that are created by the methods below.  So I can track which ones are completed an execute the callback when all are completed.
    salesforceJobs = [];
    parsedResults = [];
    totalSynced = 0;
    totalErrors = 0;
    #salesforceConverted = [];
    #errorEmail;
    #sendErrors;
    #sendGridTemplateId = "d-448c94bb53494a0b8fc69f502d86e4e7";

    constructor(connectionType) {
        if (connectionType === 'sandbox') {
            sfConnectionCredentials = salesforceSandbox;
        }
        else if (connectionType === 'production') {
            sfConnectionCredentials = salesforceProduction;
        }
        else {
            throw new Error('The connectionType must be either sandbox or production');
        }
        this.#errorEmail = 'eric@hollyburn.com';
        this.#sendErrors = true;
    }

    set errorEmail(emailAddress) {
        this.#errorEmail = emailAddress;
    }
    set sendErrorAlerts(sendErrors) {
        this.sendErrors = sendErrors;
    }

    setCallback(callback) {
        if (typeof callback === 'function') {
            this.callback = callback;
        }
    }

    //if the error flag is set to true then send a notification to eric if there are any sync errors.
    #errorNotification() {

    }

    //authenticates to the specified connection if we dont already have a connection
    async authenticate() {
        return new Promise((resolve, reject) => {
            if ((!sfConnection) || (!sfConnection.accessToken)) {
                sfConnection = new jsforce.Connection({
                    loginUrl: sfConnectionCredentials.loginUrl
                });
                sfConnection.login(sfConnectionCredentials.username, sfConnectionCredentials.password, (error, userInfo) => {
                    if (error) {
                        reject(new Error('There was an error authenticating to Salesforce.  The ere was: ' + error));
                    }
                    else {
                        resolve();
                    }
                })
            }
            else {
                resolve();
            }
        })
    }

    //splits data where there are more than 10,000 records
    async splitData(objectData) {
        // console.log('There are ' + objectData.length + ' records.');
        return new Promise((resolve, reject) => {
            try {
                let splitData = [];
                if (objectData.length>10000) {
                    let maxLoop = parseInt(objectData.length) / 10000;
                    // maxLoop = parseInt(maxLoop);
                    let currentMin = 0;
                    let currentMax = 9999;
                    console.log('maxLoop = ' + maxLoop);
                    for (let i = 1; i<= maxLoop; i++) {
                        console.log(i + ' = ' + maxLoop);
                        splitData.push(objectData.slice(currentMin, currentMax));
                        if (i===maxLoop) {
                            splitData.push(objectData.slice(currentMax, objectData.length));
                            resolve(splitData);
                        }
                        else {
                            currentMin += 9999;
                            currentMax += 9999;
                        }
                    }
                }
                else {
                    splitData.push(objectData);
                    resolve(splitData);
                }
            }
            catch (error) {
                reject(error);
            }
        });
    }

    //parses the results of a job and returns it back to the callback
    resultParser(response, batchData, jobId) {
        try {

            //finding the job / batch
            for (let i in this.salesforceJobs) {
                // console.log(this.salesforceJobs[i].jobId + ' = ' + jobId);
                if (this.salesforceJobs[i].jobId === jobId) {
                    // console.log('marking ' + jobId + ' as done.');
                    this.salesforceJobs[i].isDone = true;
                }
            }

            //looping through the data too look at row issues.
            for (let i in response) {
                if (!response[i].success) {
                    this.totalErrors += 1;
                    response[i].success = 0;
                }
                else {
                    response[i].success = 1;
                    this.totalSynced += 1;
                }
                response[i].inputData = JSON.stringify(batchData[i]);

                //adding this to the total results
                this.parsedResults.push(response[i]);

                //end of loop
                if ((parseInt(i)+1)===(parseInt(response.length))) {
                    //are all jobs completed?
                    let allJobsCompleted = true;
                    for (let i in this.salesforceJobs) {
                        if (!this.salesforceJobs[i].isDone) {
                            allJobsCompleted = false;
                        }
                        if ((parseInt(i)+1) === this.salesforceJobs.length) {
                            if (allJobsCompleted) {

                                if (this.#sendErrors && this.totalErrors) {
                                    // console.log('There were error rows detected.  Sending an error email notification');
                                    // sendgrid.sendDynamicTemplate(this.#errorEmail, this.#sendGridTemplateId, {
                                    //     //TODO add something here to send this email
                                    // });
                                }

                                let returnJson = {
                                    totalSynced: this.totalSynced,
                                    totalErrors: this.totalErrors,
                                    rowResults: this.parsedResults
                                }
                                this.callback(returnJson);
                            }
                        }
                    }
                }
            }
        }
        catch (error) {
            this.callback(null, error);
        }
    }

    //polls a salesforce job/batch for completion
    jobPoller(jobId, batchId, batchData) {
        console.log('jobPoller hit');
        console.log('jobId: ' + jobId);
        console.log('batchId: ' + batchId);
        console.log('batchData length: ' + batchData.length);

        //starting a poll for the data every 30 seconds
        let job = sfConnection.bulk.job(jobId);
        let batch = job.batch(batchId);
        batch.poll(20000, 2000000);
        batch.on("response", response => {
            console.log('received a polling response from Salesforce for a job being watched');
            console.log('this is the response: ');
            console.log(response);
            job.close();
            this.resultParser(response, batchData, jobId);
        });
    }

    //updates a single salesforce record.  must include a salesforce Id
    updateSingleRecord(salesforceObject, objectData) {
        //making sure we are authenticated to Salesforce.
        this.authenticate()
            .then(() => {
                sfConnection.sobject(salesforceObject).update(objectData, (error, results) => {
                    if (error) {
                        this.callback(null, new Error('There was an error updating Salesforce.  There error was: ' + error));
                    }
                    else {
                        this.callback(results);
                    }
                })
            })
            .catch(error => {
                this.callback(null, error);
            })
    }

    //upserts a single record.  Must include a external Id.
    async upsertSingleRecord(salesforceObject, objectData, externalId) {
        try {
            await this.authenticate();
            let results = await upsertRecord(salesforceObject, objectData, externalId);
            this.callback(results);
        }
        catch (error) {
            this.callback(null, error);
        }
    }

    //bulk upsert salesforce with an external id as the primary key
    bulkUpsertTable(salesforceObject, objectData, externalId) {
        //making sure we are authenticated to salesforce
        this.authenticate()
            .then(() => {
                // console.log('authenticated to salesforce!');
                //splitting the data into batches of 10,000 (max a bulk upload to Salesforce can be)
                this.splitData(objectData)
                    .then(splitData => {
                        // console.log('finished splitting data');
                        let requiresPolling = false;
                        let criticalError = false;
                        let criticalErrorMessage;
                        for (let i in splitData) {
                            let jobId;
                            let batchId;
                            let job = sfConnection.bulk.load(salesforceObject, 'upsert', {extIdField: externalId}, splitData[i]);
                            job.on('queue', batchInfo => {
                                this.salesforceJobs.push({
                                    jobId: batchInfo.jobId,
                                })
                                // console.log(batchInfo);
                                jobId = batchInfo.jobId;
                            })
                            job.on('error', error => {
                                if (error.name === 'PollingTimeout') {
                                    console.log('There was a pollingTimeOut error: ' + error);
                                    this.jobPoller(error.jobId, error.batchId, splitData[i]);
                                    requiresPolling = true;
                                }
                                else {
                                    //at least one of the jobs has a critical error.  Mark the sync as an error.
                                    console.log(error);
                                    criticalError = true;
                                    criticalErrorMessage = error;
                                }
                            })
                            job.on('response', response => {
                                this.resultParser(response, splitData[i], jobId);
                            })

                            //end of split data loop
                            if ((i+i) === splitData.length) {
                                if (criticalError) {
                                    this.callback(null, criticalError);
                                    this.callbackCompleted = true;
                                }
                                else if (requiresPolling) {
                                    let results = {
                                        results: "pending",
                                        message: "Atleast one batch requires polling.  Please check the database for completion status."
                                    }
                                    this.callback(results);
                                }
                            }

                        }
                    })
                    .catch(error => {
                        this.callback(null, error);
                    })
            })
            .catch(error => {
                this.callback(null, error);
            })
    }

    //takes two objects. the map object from the database and the database record being sent.  Converts to a Salesforce friendl object.
    async createSalesforceUpsertArray(databaseObject, mapObject) {

        for await (let property of databaseObject) {
            let formattedObj = {};
            Object.keys(property).forEach(key => {
                const [row] = mapObject.filter(o => o.database_name === key);
                if (row) {
                    const {database_name, salesforce_name, function_to_run} = row;
                    let value = property[key];

                    if (function_to_run) {
                        value = eval(function_to_run);
                    }

                    formattedObj = {...formattedObj, [salesforce_name]: value};
                }
            })
            this.#salesforceConverted.push(formattedObj);
        }

        return this.#salesforceConverted;

    }

}

module.exports = {Salesforce}
