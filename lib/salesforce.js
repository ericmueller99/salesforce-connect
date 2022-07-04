//@ts-check

const jsforce = require('jsforce');

//connection to Salesforce
class Salesforce {

    //connection information.  Stored in process.env OR passed in as optional arguments.
    #username;
    #password;
    #loginUrl;
    #sfConnection; //the connection object created by jsforce.

    salesforceJobs = [];
    parsedResults = [];
    totalSynced = 0;
    totalErrors = 0;
    #salesforceConverted = [];
    #callback;

    constructor(connectionType, {username = null, password = null, loginUrl = null} = {}) {
        if (connectionType === 'sandbox') {
            this.#username = username ? username : process.env.SALESFORCE_SANDBOX_USERNAME;
            this.#password = password ? password : process.env.SALESFORCE_SANDBOX_PASSWORD;
            this.#loginUrl = loginUrl ? loginUrl : process.env.SALESFORCE_SANDBOX_LOGINURL;
        }
        else if (connectionType === 'production') {
            this.#username = username ? username : process.env.SALESFORCE_PRODUCTION_USERNAME;
            this.#password = password ? password : process.env.SALESFORCE_PRODUCTION_PASSWORD;
            this.#loginUrl = loginUrl ? loginUrl : process.env.SALESFORCE_PRODUCTION_LOGINURL;
        }
    }

    set callback(callback) {

        if (!typeof callback === 'function') {
            throw new Error('callback must be a function');
        }

        this.#callback = callback;

    }

    //authenticates to the specified connection if we dont already have a connection
    authenticate() {
        return new Promise((resolve, reject) => {

            if (!this.#username || !this.#password) {
                reject(new Error('username and/or password are not set.  check environment variables or pass in credentials for constructor'));
                return;
            }

            if (this.#sfConnection && this.#sfConnection.accessToken) {
                resolve();
                return;
            }

            this.#sfConnection = new jsforce.Connection({
                loginUrl: this.#loginUrl
            });
            this.#sfConnection.login(this.#username, this.#password, (error, userInfo) => {
                if (error) {
                    reject(error);
                }
                else {
                    resolve();
                }
            })

        })
    }

    //splits data where there are more than 10,000 records
    splitData(objectData) {
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

        //TODO update this to use filter...

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

                                let returnJson = {
                                    totalSynced: this.totalSynced,
                                    totalErrors: this.totalErrors,
                                    rowResults: this.parsedResults
                                }

                                if (this.#callback && typeof this.#callback === 'function') {
                                    this.#callback(null, returnJson);
                                }

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

    #upsertRecord(salesforceObject, objectData, externalId) {
        return new Promise((resolve,reject) => {
            this.#sfConnection.sobject(salesforceObject).upsert(objectData, externalId, (error, response) => {

                if (error) {
                    reject(error);
                }

                resolve(response);

            })
        })
    }

    //updates a single salesforce record.  must include a salesforce Id
    async updateSingleRecord(salesforceObject, objectData, callback = null) {
        try {

            await this.authenticate();

            this.#sfConnection.sobject(salesforceObject).update(objectData, (error, results) => {
                if (error) {
                    return callback ? callback(error) : Promise.reject(error);
                }

                return callback ? callback(null, results) : results;

            })

        }
        catch (error) {
            return callback ? callback(error) : Promise.reject(error);
        }
    }

    //upserts a single record.  Must include a external Id.
    async upsertSingleRecord(salesforceObject, objectData, externalId, callback = null) {
        try {
            await this.authenticate();
            let results = await this.#upsertRecord(salesforceObject, objectData, externalId);
            return callback ? callback(null, results) : results;
        }
        catch (error) {
            return callback ? callback(error) : Promise.reject(error);
        }
    }

    //bulk upsert salesforce with an external id as the primary key
    async bulkUpsertTable(salesforceObject, objectData, externalId, callback) {
        try {
            //authenticating
            await this.authenticate();

            //splitting the data if its more than 10,000 records.
            const d = await this.splitData(objectData);

            let requiresPolling = false;
            let criticalError = false;
            let criticalErrors = [];

            for (let i in d) {
                let jobId;
                let batchId;
                let job = sfConnection.bulk.load(salesforceObject, 'upsert', {extIdField: externalId}, d[i]);
                job.on('queue', batchInfo => {
                    this.salesforceJobs.push({
                        jobId: batchInfo.jobId,
                    })
                    jobId = batchInfo.jobId;
                })
                job.on('error', error => {
                    if (error.name === 'PollingTimeout') {
                        console.log('There was a pollingTimeOut error: ' + error);
                        this.jobPoller(error.jobId, error.batchId, d[i]);
                        requiresPolling = true;
                    }
                    else {
                        criticalErrors.push(error);
                    }
                })
                job.on('response', response => {
                    this.resultParser(response, d[i], jobId);
                })

                //end of split data loop
                if ((i+i) === d.length) {
                    if (criticalError) {
                        return callback ? callback(new Error('Salesforce sync finished with errors.')) : Promise.reject('Salesforce sync finished with errors');
                    }
                    else if (requiresPolling) {
                        let results = {
                            result: "pending",
                            message: "Atleast one batch requires polling.  Please check the database for completion status."
                        }
                        return callback ? callback(null, results) : results;
                    }
                }

            }

        }
        catch (error) {
            return callback ? callback(error) : Promise.reject(error);
        }

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

    //inserts a single record.
    async insertSingleRecord(objectName, record, callback = null) {
        return new Promise(async (resolve,reject) => {
            try {
                if (!objectName || !record) {
                    return callback ? callback(new Error('objectName and record are required')) : reject(new Error('objectName and record are required'));
                }

                await this.authenticate();

                this.#sfConnection.sobject(objectName).create(record, (error, res) => {

                    if (error) {
                        return callback ? callback(error) : reject(error);
                    }

                    if (!res.success) {
                        const {errors} = res.errors;
                        return callback ? callback(new Error(`Error creating record.  Ererors were ${errors}`)) : reject(new Error(`Error creating record.  Ererors were ${errors}`))
                    }

                    return callback ? callback(null, res) : resolve(res);

                })
            }
            catch (error) {
                return callback ? callback(error) : reject(error);
            }
        })
    }

}

module.exports = {Salesforce}
