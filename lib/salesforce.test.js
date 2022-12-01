const {Salesforce} = require('./salesforce');


(() => {

    const config = {
        username: process.env.SALESFORCE_PRODUCTION_USERNAME,
        password: process.env.SALESFORCE_PRODUCTION_PASSWORD,
        loginUrl: process.env.SALESFORCE_PRODUCTION_LOGIN_URL,
        clientId: process.env.SALESFORCE_PRODUCTION_CLIENT_ID,
        clientSecret: process.env.SALESFORCE_PRODUCTION_CLIENT_SECRET
    }
    const salesforce = new Salesforce('production', config);
    const query = `SELECT ID, Name, FirstName, LastName, Email, Phone FROM Lead WHERE CreatedDate >= 2022-10-01T00:00:00Z`;
    salesforce.getRecordsFromSOQLBulk(query)
        .then(data => {
            console.log(data);
        })
        .catch(error => {
            console.log(error);
        })

})()