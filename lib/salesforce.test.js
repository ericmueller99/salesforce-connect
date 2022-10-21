const {Salesforce} = require('./salesforce');

// test('getLeadOrContact', () => {
//     const salesforce = new Salesforce('sandbox');
//     salesforce.getLeadOrContact('ericmueller99@gmail.com')
//         .then(data => {
//             console.log(data);
//         })
//         .catch(error => {
//             console.log(error);
//         })
// })

getLeadOrContact = () => {
    const salesforce = new Salesforce('sandbox');
    salesforce.getLeadOrContact('ericmueller99@gmail.com')
        .then(data => {
            console.log(data);
        })
        .catch(error => {
            console.log(error)
        })
}
// getLeadOrContact();


//