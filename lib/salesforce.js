//@ts-check

const jsforce = require('jsforce');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const os = require('os');

//connection to Salesforce
class Salesforce {

    //connection information.  Stored in process.env OR passed in as optional arguments.
    #username;
    #password;
    #loginUrl;
    #clientId;
    #clientSecret;
    #sfConnection; //the connection object created by jsforce.
    #currentRetries = 0;
    #authType;
    #restAuthInfo = {
        accessToken: null,
        instanceUrl: null,
        id: null,
        tokenType: null,
        issuedAt: null,
        signature: null
    }

    jobs = [];
    totalSynced = 0;
    totalErrors = 0;
    totalJobs = 0;
    maxRetries = 5;

    //if a single Lead or Contact is being worked with
    leadOrContact = {
        //Salesforce fields
        Id: null,
        FirstName: null,
        LastName: null,
        Email: null,
        Phone: null,
        Preference__c: {
            Suite_Type__c: null,
            Maximum_Budget__c: null,
            Desired_Move_In_Date__c: null,
            Number_of_Occupants__c: null,
            City__c: null,
            Neighbourhood__c: null
        },
        //non Salesforce fields
        isQualified: false,
        recordType: null,
        invalidFields: []
    }

    //must match these conditions to be considered qualified at Hollyburn
    #qualifiedRules = {
        FirstName: (firstName) => {
            return !!firstName
        },
        LastName: (lastName) => {
            return !(!lastName || lastName.toLowerCase() === 'Unknown');
        },
        Email: (emailAddress) => {
            return !!emailAddress; //We are trusting the Salesforce will correctly validate the email address here.
        },
        Phone: (phone) => {
            console.log(!!phone);
            return !!phone;
        },
        Preference__c: {
            Suite_Type__c: (suiteType) => {
                return !!suiteType;
            },
            Maximum_Budget__c: (maxBudget) => {
                if (!maxBudget || !parseInt(maxBudget)) {
                    return false;
                }
                return maxBudget >= 500;
            },
            Desired_Move_In_Date__c: (moveIn) => {
                try {
                    const currentDate = new Date();
                    const formattedDate = new Date(moveIn);
                    const difference = formattedDate.getTime() - currentDate.getTime();
                    const differenceInMonths = difference / 2629746000;
                    return differenceInMonths <= 9;
                }
                catch (e) {
                    return false;
                }
            },
            Number_of_Occupants__c: (occupants) => {
                return !(!occupants || !parseInt(occupants));
            },
            City__c: (city) => {
                return !!city;
            },
            Neighbourhood__c: (neighbourhood) => {
                const neighbourhoodsReq = new Set(['Vancouver', 'Toronto']);
                if (neighbourhoodsReq.has(this.leadOrContact.Preference__c.City__c)) {
                    return !!neighbourhood;
                }
                return true;
            }
        }
    }

    constructor(connectionType, {username = null, password = null, loginUrl = null, clientId = null, clientSecret = null} = {}) {
        if (connectionType === 'sandbox') {
            this.#username = username ? username : process.env.SALESFORCE_SANDBOX_USERNAME;
            this.#password = password ? password : process.env.SALESFORCE_SANDBOX_PASSWORD;
            this.#loginUrl = loginUrl ? loginUrl : process.env.SALESFORCE_SANDBOX_LOGINURL;
            this.#clientId = clientId ? clientId : process.env.SALESFORCE_SANDBOX_CLIENT_ID;
            this.#clientSecret = clientSecret ? clientSecret : process.env.SALESFORCE_SANDBOX_CLIENT_SECRET;
        }
        else if (connectionType === 'production') {
            this.#username = username ? username : process.env.SALESFORCE_PRODUCTION_USERNAME;
            this.#password = password ? password : process.env.SALESFORCE_PRODUCTION_PASSWORD;
            this.#loginUrl = loginUrl ? loginUrl : process.env.SALESFORCE_PRODUCTION_LOGINURL;
            this.#clientId = clientId ? clientId : process.env.SALESFORCE_PRODUCTION_CLIENT_ID;
            this.#clientSecret = clientSecret ? clientSecret : process.env.SALESFORCE_PRODUCTION_CLIENT_SECRET;
        }
        this.#createTmpDir();
    }

    //authenticates to the specified connection if we don't already have a connection
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
                    this.#authType = 'JSFORCE';
                    resolve();
                }
            })

        })
    }

    //get a bearer token from the REST API isntead.
    //TODO remove the hard coded auth information!!!!!!!
    async authenticateViaRest(reauthenticate = false) {

        //if there is no client secret or clientId then return an error.
        if (!this.#clientSecret || !this.#clientId) {
            throw new Error('this authentication method requires a clientSecret and clientId');
        }

        //if there is already an accessToken and reauth = false then return resolved promise.
        if (this.#restAuthInfo.accessToken === null || reauthenticate === true) {

            console.log('authenticating to Salesforce');

            //authenticate to the Salesforce oauth service.
            const url = `https://login.salesforce.com/services/oauth2/token?grant_type=password&client_id=${this.#clientId}&client_secret=${this.#clientSecret}&username=${this.#username}&password=${this.#password}`
            const res = await axios.post(url)
            const {access_token, instance_url, id, token_type, issued_at, signature} = res.data;

            //if there is no auth_token returned throw and error.
            if (!access_token) {
                return Promise.reject(new Error('Unable to authenticate to Salesforce'));
            }

            //set connection details in class.
            this.#authType = 'REST';
            this.#restAuthInfo = {
                accessToken: access_token,
                instanceUrl: instance_url,
                id: id,
                tokenType: token_type,
                issuedAt: issued_at,
                signature: signature
            }

        }
        //get a new auth token
        else {
            return Promise.resolve();
        }

    }

    //splits data where there are more than 10,000 records
    splitData(objectData) {
        return new Promise((resolve) => {

            if (!Array.isArray(objectData)) {
                throw new Error('objectData must be an array');
            }

            const splitData = []
            if (objectData.length <= 9999) {
                splitData.push(objectData);
                resolve(splitData);
                return;
            }

            let startIndex = 0;
            let endIndex = 9999;
            while (endIndex < objectData.length) {
                splitData.push(objectData.slice(startIndex, endIndex));
                startIndex = endIndex;
                if ((endIndex + 9999) > objectData.length) {
                    endIndex = objectData.length;
                    splitData.push(objectData.slice(startIndex, endIndex));
                }
                else {
                    endIndex = endIndex + 9999;
                }
            }

            resolve(splitData);

        });
    }

    //parses the results of a job and returns it back to the callback
    #resultParser() {

        if (this.jobs.length <= 0) {
            throw new Error('there must be at minimum one completed job to use resultParser');
        }

        this.totalJobs = this.jobs.length;

        for (const job of this.jobs) {
            const errorRows = job.responseData.filter(j => !j.success) || [];
            const successRows = job.responseData.filter(j => j.success) || [];
            this.totalSynced += successRows.length;
            if (errorRows.length > 0) {
                this.#updateJob(job.jobId, {
                    hadRowErrors: true,
                    rowErrors: errorRows
                })
                this.totalErrors += errorRows.length;
            }
            else {
                this.#updateJob(job.jobId, {
                    hadRowErrors: false
                })
            }
        }

    }

    //polls a salesforce job/batch for completion
    #jobPoller(jobId, batchId) {
        return new Promise((resolve) => {
            const job = this.#sfConnection.bulk.job(jobId);
            const batch = job.batch(batchId);
            batch.poll(20000, 2000000);
            batch.on("response", response => {
                job.close()
                    .then(data => {
                        this.#updateJob(jobId, {completed: true, responseData: response})
                        resolve();
                    })
                    .catch(error => {
                        this.#updateJob(jobId, {hadError: true, error: error})
                        resolve();
                    })
            });
        })
    }

    //upsert single record
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

    #updateJob(jobId, updatedData) {

        const [job] = this.jobs.filter(j => j.jobId === jobId);
        if (!job) {
            this.jobs.push({
                jobId,
                ...updatedData
            });
        }
        else {
            for (const i in this.jobs) {
                if (this.jobs[i].jobId === jobId) {
                    this.jobs[i] = {
                        ...this.jobs[i],
                        ...updatedData
                    }
                    break;
                }
            }
        }

    }

    //bulk load data
    #bulkLoad(salesforceObject, data, externalId, operation = 'upsert') {
        return new Promise((resolve) => {

            const options = {
                extIdField: externalId ? externalId : null
            }

            let jobId;
            const job = this.#sfConnection.bulk.load(salesforceObject, operation, options, data);
            job.on('queue', batchInfo => {
                this.jobs.push({
                    jobId: batchInfo.jobId,
                    requestData: data
                })
                jobId = batchInfo.jobId;
            })
            job.on('error', error => {
                console.log(error);
                if (error.name === 'PollingTimeout') {
                    console.log('There was a pollingTimeOut error: ' + error);
                    this.#updateJob(jobId, {requiresPolling: true, batchId: error.batchId});
                }
                else {
                    this.#updateJob(jobId, {hadError: true, error: error})
                }
                resolve();
            })
            job.on('response', response => {
                this.#updateJob(jobId, {completed: true, responseData: response})
                resolve();
            })
        })
    }

    //create poll jobs for any that need it and wait for them to complete.
    async #checkPollingRequired() {
        //if any of the jobs require polling wait for them to finish.
        const requiresPolling = this.jobs.filter(j => j.requiresPolling) || [];
        if (requiresPolling.length > 0) {
            const pollingPromises = [];
            for (const p of requiresPolling) {
                pollingPromises.push(this.#jobPoller(p.jobId, p.batchId))
            }
            await Promise.all(pollingPromises);
        }
    }

    //bulk update (instead of upsert)
    async bulkUpdateTable(salesforceObject, objectData, callback) {
        try {

            //authenticating
            await this.authenticate();

            //splitting the data if needed
            const d = await this.splitData(objectData);

            //syncing the data to Salesforce.
            const jobPromises = [];
            for (const batch of d) {
                jobPromises.push(this.#bulkLoad(salesforceObject, batch, null, 'update'));
            }
            await Promise.all(jobPromises);

            //if any jobs require polling to complete.
            await this.#checkPollingRequired();

            //parse the results
            this.#resultParser();

            return callback ? callback(null, this) : Promise.resolve(this);

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

            //syncing the data to salesforce.
            const jobPromises = [];
            for (const i of d) {
                jobPromises.push(this.#bulkLoad(salesforceObject, i, externalId, 'upsert'));
            }
            await Promise.all(jobPromises);

            //if any jobs require polling to complete.
            await this.#checkPollingRequired();

            //parse the results
            this.#resultParser();

            return callback ? callback(null, this) : Promise.resolve(this);

        }
        catch (error) {
            return callback ? callback(error) : Promise.reject(error);
        }
    }

    //takes two objects. the map object from the database and the database record being sent.  Converts to a Salesforce friendl object.
    async createSalesforceUpsertArray(databaseObject, mapObject) {

        const salesforceConverted = [];

        for await (let property of databaseObject) {
            let formattedObj = {};
            Object.keys(property).forEach(key => {
                const [row] = mapObject.filter(o => o.database_name === key) || [];
                if (row) {
                    const {database_name, salesforce_name, function_to_run} = row;
                    let value = property[key];

                    if (function_to_run) {
                        value = eval(function_to_run);
                    }

                    //exclude null values for relationships
                    if (!value && salesforce_name.includes('.')) {

                    }
                    else {
                        formattedObj = {...formattedObj, [salesforce_name]: value};
                    }

                }
            })
            salesforceConverted.push(formattedObj);
        }

        return salesforceConverted;

    }

    //inserts a single record.
    insertSingleRecord(objectName, record, callback = null) {
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
                        return callback ? callback(new Error(`Error creating record.  errors were ${errors}`)) : reject(new Error(`Error creating record.  errors were ${errors}`))
                    }

                    return callback ? callback(null, res) : resolve(res);

                })
            }
            catch (error) {
                return callback ? callback(error) : reject(error);
            }
        })
    }

    //SOSL Query
    #search(statement) {
        return new Promise((resolve, reject) => {
            this.#sfConnection.search(statement, (err, response) => {
                if (err) {
                    console.log('error!');
                    reject(err);
                    return;
                }
                const {searchRecords} = response;
                resolve(searchRecords);
            })
        })
    }

    //SOQL query.
    #query(statement) {
        return new Promise((resolve,reject) => {
            let records = [];
            let query = this.#sfConnection.query(statement)
                .on("record", (record) => {
                    records.push(record);
                })
                .on('end', () => {
                    resolve(records);
                })
                .on('error', (error) => {
                    console.log('this is the error hit from #query');
                    console.log(error);
                    reject(error);
                })
                .run({autoFetch: true})
        })
    }

    /**
     * create a tmp directory
     */
    #createTmpDir() {
        if (!fs.existsSync(path.join(os.tmpdir(), 'salesforce-connect'))) {
            fs.mkdirSync(path.join(os.tmpdir(), 'salesforce-connect'));
        }
    }

    /**
     * send an axios request.
     * @param url
     * @param method
     * @param body
     * @param query
     * @returns {Promise<*>}
     */
    async #sendRestRequest(url, method = 'get', body = null, query = null) {
        const config = {
            headers: {
                Authorization: `Bearer ${this.#restAuthInfo.accessToken}`
            },
            data: body,
            method: method,
            url,
            query: query
        }
        const res = await axios(config);
        return res.data;
    }

    /**
     * polls a bulk version 2 job and gets its data.
     * @param jobId
     * @param locator
     * @returns {Promise<void>}
     */
    async getJobData(jobId, locator = null) {

        await this.authenticateViaRest()

        console.log('getting job data');

        try {

            //get the csv data from salesforce bulk API
            const url = `${this.#restAuthInfo.instanceUrl}/services/data/v56.0/jobs/query/${jobId}/results?maxRecords=10000${locator ? `&locator=${locator}`: ''}`
            const config = {
                headers: {
                    Authorization: `Bearer ${this.#restAuthInfo.accessToken}`
                }
            }
            const res = await axios.get(url, config);

            //get the locator spot from the header to see if more data should be retrieved.
            locator = res.headers['sforce-locator'] || null
            fs.writeFileSync(path.join(os.tmpdir(), `salesforce-connect/${locator !== null ? locator : `${jobId}-last`}.csv`), res.data, 'utf8');

            //convert the data to csv
            const processData = () => {
                return new Promise(resolve => {

                    //process the data and return it
                    let csvData = [];
                    fs.createReadStream(path.join(os.tmpdir(), `salesforce-connect/${locator !== null ? locator : `${jobId}-last`}.csv`))
                    .pipe(csv())
                    .on('data', data => {
                        csvData.push(data);
                    })
                    .on('end', () => {
                        if (fs.existsSync(path.join(os.tmpdir(), `salesforce-connect/${locator !== null ? locator : `${jobId}-last`}.csv`))) {
                            fs.unlinkSync(path.join(os.tmpdir(), `salesforce-connect/${locator !== null ? locator : `${jobId}-last`}.csv`));
                        }
                        resolve(csvData)
                    });

                });
            }

            //getting the data from the csv parser.
            const formattedData = await processData();

            //update the job data.
            const [job] = this.jobs.filter(j => j.jobId === jobId);

            const existingData = job?.responseData || [];
            const mergedData = [...existingData, ...formattedData];
            this.#updateJob(jobId, {responseData: mergedData})

            //if there is a locator then recall the function to get the next batch of data.
            if (locator !== null && locator !== 'null') {
                console.log(`locator exists.  it is ${locator}.  Calling getData again`);
                await this.getJobData(jobId, locator);
            }

        }
        catch (error) {
            console.log(error);
            console.log(error.response.data[0]);
        }

    }

    /**
     * Poll a batch version 2 job on the Salesforce API
     * @param jobId
     * @returns {Promise<unknown>}
     */
    #pollBulkV2Job(jobId) {
        return new Promise((resolve, reject) => {

            //this function is recalled until the batch is in the right state
            const recursiveWrapper = () => {

                console.log('polling bulk v2 job');

                this.#sendRestRequest(`${this.#restAuthInfo.instanceUrl}/services/data/v56.0/jobs/query/${jobId}`)
                .then(jobData => {
                    const {state} = jobData;
                    if (state === 'Failed' || state === 'Aborted') {
                        reject(new Error(`job was ${state}`))
                    }
                    else if (state === 'UploadComplete' || state === 'InProgress') {
                        this.#updateJob(jobId, {state})
                        setTimeout(() => {
                            recursiveWrapper();
                        }, 10000);
                    }
                    else if (state === 'JobComplete') {
                        this.#updateJob(jobId, {state});
                        this.getJobData(jobId)
                        .then(() => {
                            console.log('done getting data!')
                            const [job] = this.jobs.filter(j => j.jobId === jobId);
                            resolve(job);
                        })
                        .catch(error => {
                            console.log(error);
                            reject(error);
                        })
                    }
                })
                .catch(error => {
                    console.log(error);
                    reject(error);
                })
            }
            recursiveWrapper()

        });
    }

    /**
     * executes a query via the bulk interface.  use this for SOQL queries that have more than 10,000 records.
     * @param statement
     * @returns {Promise<unknown>}
     */
    async #bulkQuery(statement) {

        try {
            //create bulk request.
            const queryRequest = await this.#sendRestRequest(`${this.#restAuthInfo.instanceUrl}/services/data/v56.0/jobs/query`, 'post', {operation: 'query', query: statement});
            const {id, state} = queryRequest;
            if (!id) {
                return Promise.reject(new Error('Unable to create job.  No id returned from Salesforce'));
            }

            //add the job.
            this.jobs.push({
                jobId: id,
                state,
                requestData: statement,
                type: 'bulkQuery'
            });

            //return the results of the job
            const data = await this.#pollBulkV2Job(id);
            return data.responseData;

        }
        catch(error) {
            console.log('#bulkQuery had an error');
            console.log(statement);
            throw error;
        }

    }

    async isQualified() {

        this.leadOrContact.isQualified = true;

        if (!this.leadOrContact.Id) {
            this.leadOrContact.isQualified = false;
            return false;
        }

        this.leadOrContact.invalidFields = [];

        //testing each of the rules.
        await Object.keys(this.#qualifiedRules).forEach(key => {
            if (this.leadOrContact[key]) {
                if (typeof this.#qualifiedRules[key] === 'object') {
                    Object.keys(this.#qualifiedRules[key]).forEach(subKey => {
                        if (!this.#qualifiedRules[key][subKey](this.leadOrContact[key][subKey])) {
                            console.log(`${key} and ${subKey} has failed validation.  Lead is not qualified`);
                            this.leadOrContact.isQualified = false;
                            this.leadOrContact.invalidFields.push(`${key}.${subKey}`);
                            return false;
                        }
                    })
                }
                else {
                    if (!this.#qualifiedRules[key](this.leadOrContact[key])) {
                        console.log(`${key} has failed validation.  Lead is not qualified`);
                        this.leadOrContact.isQualified = false;
                        this.leadOrContact.invalidFields.push(key);
                        return false;
                    }
                }
            } else {
                console.log(`${key} is null or invalid.  Lead is not qualified`);
                this.leadOrContact.isQualified = false;
                this.leadOrContact.invalidFields.push(key);
                return false;
            }
        });

    }

    //takes an array of leadsOrContacts and returns the one that has the most information.
    #mostInformationFinder(arrayOfRecords) {

        if (!Array.isArray(arrayOfRecords)) {
            throw new Error('arrayOfRecords must be an array.');
        }

        let record;
        let recordNullCount;
        for (const c of arrayOfRecords) {
            let nullFieldCount = 0;
            Object.keys(c).forEach(cc => {
                if (c[cc] === null) {
                    nullFieldCount +=1;
                }
            })
            if (!record) {
                record = c;
                recordNullCount = nullFieldCount;
            }
            else {
                if (nullFieldCount < recordNullCount) {
                    record = c;
                    recordNullCount = nullFieldCount;
                }
            }
        }

        return record;

    }

    //searches for the a lead and also determines if they are qualified or not
    async getLeadOrContact(emailAddress, callback = null) {
        try {

            if (!emailAddress) {
                return callback ? callback(new Error('emailAddress is required')) : Promise.reject(new Error('emailAddress is required'));
            }

            await this.authenticate();

            const findQuery = `FIND {${emailAddress}} IN EMAIL FIELDS RETURNING Lead(Id, FirstName, LastName, Email, Phone), Contact(Id, FirstName, LastName, Email, Phone)`;
            const searchResults = await this.#search(findQuery);

            const contacts = searchResults.filter(c => c.attributes.type === 'Contact') || [];
            const leads = searchResults.filter(e => e.attributes.type === 'Lead') || [];

            let leadOrContact;
            if (contacts.length === 1) {
                leadOrContact = contacts[0];
            }
            else if (contacts.length > 1) {
                leadOrContact = this.#mostInformationFinder(contacts);
            }
            else if (leads.length === 1) {
                leadOrContact = leads[0]
            }
            else if (leads.length > 1) {
                leadOrContact = this.#mostInformationFinder(leads);
            }
            else {
                return callback ? callback(null, []) : [];
            }

            //making sure that mostInformationFinder returned a value
            if (!leadOrContact?.Id) {
                return callback ? callback(null, []) : [];
            }

            const prefQuery = `SELECT Id, Suite_Type__c, Maximum_Budget__c, Desired_Move_In_Date__c, Number_of_Occupants__c, City__c, Neighbourhood__c, Pet_Friendly__c
                                from Preference__c where Contact_Name__c='${leadOrContact.Id}' or Lead_Name__c='${leadOrContact.Id}'`;
            const preferences = await this.#query(prefQuery);
            if (preferences.length > 1) {
                leadOrContact.Preference__c = this.#mostInformationFinder(preferences);
            }
            else if (preferences.length === 1) {
                leadOrContact.Preference__c = preferences[0];
            }
            else if (preferences.length === 0) {
                leadOrContact.Preference__c = null;
            }

            const {type} = leadOrContact.attributes;
            leadOrContact.recordType = type;
            this.leadOrContact = leadOrContact;

            //is the lead qualified?
            await this.isQualified();

            return callback ? callback(null, this.leadOrContact) : this.leadOrContact;

        }
        catch (error) {
            return callback ? callback(error) : Promise.reject(error);
        }
    }

    //runs a SOQL statement and returns the records
    async getRecordsFromSOQL(statement) {

        await this.authenticate();
        const records = await this.#query(statement);
        return records || [];

    }

    /**
     * executes a query via the bulk interface.  use this for SOQL queries that have more than 10,000 records.
     * @param statement
     * @returns {Promise<*>}
     */
    async getRecordsFromSOQLBulk(statement) {

        //bulk version 2 works much better for this query.  jsforce is not emitting events properly.
        await this.authenticateViaRest();
        const records = await this.#bulkQuery(statement);
        return records || [];

    }

}

module.exports = {Salesforce}
